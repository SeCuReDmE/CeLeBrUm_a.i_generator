import { LivechatRooms, Messages, Uploads, Users, LivechatVisitors } from '@rocket.chat/models';
import { PdfWorker } from '@rocket.chat/pdf-worker';
import type { Templates } from '@rocket.chat/pdf-worker';
import type { IMessage, IUser, IRoom, IUpload, ILivechatVisitor, ILivechatAgent } from '@rocket.chat/core-typings';
import { ServiceClass } from '@rocket.chat/core-services';
import type { Upload, Message, QueueWorker, Translation, IOmnichannelTranscriptService, Settings } from '@rocket.chat/core-services';
import { guessTimezone, guessTimezoneFromOffset } from '@rocket.chat/tools';
import type { TranslationKey } from '@rocket.chat/ui-contexts';

import type { Logger } from '../../../../apps/meteor/server/lib/logger/Logger';

const isPromiseRejectedResult = (result: any): result is PromiseRejectedResult => result.status === 'rejected';

type WorkDetails = {
	rid: IRoom['_id'];
	userId: IUser['_id'];
};

type WorkDetailsWithSource = WorkDetails & {
	from: string;
};

type MessageWithFiles = Pick<IMessage, '_id' | 'ts' | 'u' | 'msg' | 'md'> & {
	files: ({ name?: string; buffer: Buffer | null } | undefined)[];
};

type WorkerData = {
	siteName: string;
	visitor: ILivechatVisitor | null;
	agent: ILivechatAgent | undefined;
	closedAt?: Date;
	messages: MessageWithFiles[];
	timezone: string;
	dateFormat: string;
	timeAndDateFormat: string;
	translations: { key: TranslationKey; value: string }[];
};

export class OmnichannelTranscript extends ServiceClass implements IOmnichannelTranscriptService {
	protected name = 'omnichannel-transcript';

	private worker: PdfWorker;

	private log: Logger;

	maxNumberOfConcurrentJobs = 25;

	currentJobNumber = 0;

	constructor(
		private readonly uploadService: typeof Upload,
		private readonly messageService: typeof Message,
		private readonly queueService: typeof QueueWorker,
		private readonly translationService: typeof Translation,
		private readonly settingsService: typeof Settings,
		loggerClass: typeof Logger,
	) {
		super();
		this.worker = new PdfWorker('chat-transcript');
		// eslint-disable-next-line new-cap
		this.log = new loggerClass('OmnichannelTranscript');
	}

	async getTimezone(user?: { utcOffset?: string | number }): Promise<string> {
		const reportingTimezone = await this.settingsService.get('Default_Timezone_For_Reporting');

		switch (reportingTimezone) {
			case 'custom':
				return this.settingsService.get<string>('Default_Custom_Timezone');
			case 'user':
				if (user?.utcOffset) {
					return guessTimezoneFromOffset(user.utcOffset);
				}
				return guessTimezone();
			default:
				return guessTimezone();
		}
	}

	private getMessagesFromRoom({ rid }: { rid: string }): Promise<IMessage[]> {
		// Closing message should not appear :)
		return Messages.findLivechatMessagesWithoutClosing(rid, {
			sort: { ts: 1 },
			projection: { _id: 1, msg: 1, u: 1, t: 1, ts: 1, attachments: 1, files: 1, md: 1 },
		}).toArray();
	}

	async requestTranscript({ details }: { details: WorkDetails }): Promise<void> {
		this.log.log(`Requesting transcript for room ${details.rid} by user ${details.userId}`);
		const room = await LivechatRooms.findOneById(details.rid);
		if (!room) {
			throw new Error('room-not-found');
		}

		if (room.open) {
			throw new Error('room-still-open');
		}

		if (!room.servedBy || !room.v) {
			throw new Error('improper-room-state');
		}

		// Don't request a transcript if there's already one requested :)
		if (room.pdfTranscriptRequested) {
			// TODO: use logger
			this.log.log(`Transcript already requested for room ${details.rid}`);
			return;
		}

		await LivechatRooms.setTranscriptRequestedPdfById(details.rid);

		// Even when processing is done "in-house", we still need to queue the work
		// to avoid blocking the request
		this.log.log(`Queuing work for room ${details.rid}`);
		await this.queueService.queueWork('work', `${this.name}.workOnPdf`, {
			template: 'omnichannel-transcript',
			details: { userId: details.userId, rid: details.rid, from: this.name },
		});
	}

	private async getFiles(userId: string, messages: IMessage[]): Promise<MessageWithFiles[]> {
		return Promise.all(
			messages.map(async (message: IMessage) => {
				if (!message.attachments || !message.attachments.length) {
					// If there's no attachment and no message, what was sent? lol
					return { _id: message._id, files: [], ts: message.ts, u: message.u, msg: message.msg, md: message.md };
				}

				const files = await Promise.all(
					message.attachments.map(async (attachment) => {
						this.log.error(JSON.stringify(attachment, null, 2));
						// @ts-expect-error - messages...
						if (attachment.type !== 'file') {
							// @ts-expect-error - messages...
							this.log.error(`Invalid attachment type ${attachment.type} for file ${attachment.title} in room ${message.rid}!`);
							// ignore other types of attachments
							return;
						}
						// @ts-expect-error - messages...
						if (!this.worker.isMimeTypeValid(attachment.image_type)) {
							// @ts-expect-error - messages...
							this.log.error(`Invalid mime type ${attachment.image_type} for file ${attachment.title} in room ${message.rid}!`);
							// ignore invalid mime types
							return { name: attachment.title, buffer: null };
						}
						let file = message.files?.map((v) => ({ _id: v._id, name: v.name })).find((file) => file.name === attachment.title);
						if (!file) {
							this.log.debug(`File ${attachment.title} not found in room ${message.rid}!`);
							// For some reason, when an image is uploaded from clipboard, it doesn't have a file :(
							// So, we'll try to get the FILE_ID from the `title_link` prop which has the format `/file-upload/FILE_ID/FILE_NAME` using a regex
							const fileId = attachment.title_link?.match(/\/file-upload\/(.*)\/.*/)?.[1];
							if (!fileId) {
								this.log.error(`File ${attachment.title} not found in room ${message.rid}!`);
								// ignore attachments without file
								return { name: attachment.title, buffer: null };
							}
							file = { _id: fileId, name: attachment.title || 'upload' };
						}

						if (!file) {
							this.log.error(`File ${attachment.title} not found in room ${message.rid}!`);
							// ignore attachments without file
							return { name: attachment.title, buffer: null };
						}

						const uploadedFile = await Uploads.findOneById(file._id);
						if (!uploadedFile) {
							this.log.error(`Uploaded file ${file._id} not found in room ${message.rid}!`);
							// ignore attachments without file
							return { name: file.name, buffer: null };
						}

						const fileBuffer = await this.uploadService.getFileBuffer({ userId, file: uploadedFile });
						return { name: file.name, buffer: fileBuffer };
					}),
				);

				// When you send a file message, the things you type in the modal are not "msg", they're in "description" of the attachment
				// So, we'll fetch the the msg, if empty, go for the first description on an attachment, if empty, empty string
				const msg = message.msg || message.attachments.find((attachment) => attachment.description)?.description || '';
				// Remove nulls from final array
				return { _id: message._id, msg, u: message.u, files: files.filter(Boolean), ts: message.ts };
			}),
		);
	}

	private async getTranslations(): Promise<Array<{ key: TranslationKey; value: string }>> {
		const keys: TranslationKey[] = [
			'Agent',
			'Date',
			'Customer',
			'Omnichannel_Agent',
			'Time',
			'Chat_transcript',
			'This_attachment_is_not_supported',
		];

		return Promise.all(
			keys.map(async (key) => {
				return {
					key,
					value: await this.translationService.translateToServerLanguage(key),
				};
			}),
		);
	}

	async workOnPdf({ template, details }: { template: Templates; details: WorkDetailsWithSource }): Promise<void> {
		this.log.log(`Processing transcript for room ${details.rid} by user ${details.userId} - Received from queue`);
		if (this.maxNumberOfConcurrentJobs <= this.currentJobNumber) {
			this.log.error(`Processing transcript for room ${details.rid} by user ${details.userId} - Too many concurrent jobs, queuing again`);
			throw new Error('retry');
		}
		this.currentJobNumber++;
		try {
			const room = await LivechatRooms.findOneById(details.rid);
			if (!room) {
				throw new Error('room-not-found');
			}
			const messages = await this.getMessagesFromRoom({ rid: room._id });

			const visitor =
				room.v && (await LivechatVisitors.findOneById(room.v._id, { projection: { _id: 1, name: 1, username: 1, visitorEmails: 1 } }));
			const agent =
				room.servedBy && (await Users.findOneAgentById(room.servedBy._id, { projection: { _id: 1, name: 1, username: 1, utcOffset: 1 } }));

			const messagesFiles = await this.getFiles(details.userId, messages);

			const [siteName, dateFormat, timeAndDateFormat, timezone, translations] = await Promise.all([
				this.settingsService.get<string>('Site_Name'),
				this.settingsService.get<string>('Message_DateFormat'),
				this.settingsService.get<string>('Message_TimeAndDateFormat'),
				this.getTimezone(agent),
				this.getTranslations(),
			]);
			const data = {
				visitor,
				agent,
				closedAt: room.closedAt,
				siteName,
				messages: messagesFiles,
				dateFormat,
				timeAndDateFormat,
				timezone,
				translations,
			};

			await this.doRender({ template, data, details });
		} catch (error) {
			await this.pdfFailed({ details, e: error as Error });
		} finally {
			this.currentJobNumber--;
		}
	}

	async doRender({ template, data, details }: { template: Templates; data: WorkerData; details: WorkDetailsWithSource }): Promise<void> {
		const buf: Uint8Array[] = [];
		let outBuff = Buffer.alloc(0);
		const transcriptText = await this.translationService.translateToServerLanguage('Transcript');

		const stream = await this.worker.renderToStream({ template, data });
		stream.on('data', (chunk) => {
			buf.push(chunk);
		});
		stream.on('end', () => {
			outBuff = Buffer.concat(buf);

			return this.uploadService
				.uploadFile({
					userId: details.userId,
					buffer: outBuff,
					details: {
						// transcript_{company-name)_{date}_{hour}.pdf
						name: `${transcriptText}_${data.siteName}_${new Intl.DateTimeFormat('en-US').format(new Date())}_${
							data.visitor?.name || data.visitor?.username || 'Visitor'
						}.pdf`,
						type: 'application/pdf',
						rid: details.rid,
						// Rocket.cat is the goat
						userId: 'rocket.cat',
						size: outBuff.length,
					},
				})
				.then((file) => this.pdfComplete({ details, file }))
				.catch((e) => this.pdfFailed({ details, e }));
		});
	}

	private async pdfFailed({ details, e }: { details: WorkDetailsWithSource; e: Error }): Promise<void> {
		this.log.error(`Transcript for room ${details.rid} by user ${details.userId} - Failed: ${e.message}`);
		const room = await LivechatRooms.findOneById(details.rid);
		if (!room) {
			return;
		}
		const user = await Users.findOneById(details.userId);
		if (!user) {
			return;
		}

		// Remove `transcriptRequestedPdf` from room to allow another request
		await LivechatRooms.unsetTranscriptRequestedPdfById(details.rid);

		const { rid } = await this.messageService.createDirectMessage({ to: details.userId, from: 'rocket.cat' });
		this.log.log(`Transcript for room ${details.rid} by user ${details.userId} - Sending error message to user`);
		await this.messageService.sendMessage({
			fromId: 'rocket.cat',
			rid,
			msg: `${await this.translationService.translate('pdf_error_message', user)}: ${e.message}`,
		});
	}

	private async pdfComplete({ details, file }: { details: WorkDetailsWithSource; file: IUpload }): Promise<void> {
		this.log.log(`Transcript for room ${details.rid} by user ${details.userId} - Complete`);
		const user = await Users.findOneById(details.userId);
		if (!user) {
			return;
		}
		// Send the file to the livechat room where this was requested, to keep it in context
		try {
			const [, { rid }] = await Promise.all([
				LivechatRooms.setPdfTranscriptFileIdById(details.rid, file._id),
				this.messageService.createDirectMessage({ to: details.userId, from: 'rocket.cat' }),
			]);

			this.log.log(`Transcript for room ${details.rid} by user ${details.userId} - Sending success message to user`);
			const result = await Promise.allSettled([
				this.uploadService.sendFileMessage({
					roomId: details.rid,
					userId: 'rocket.cat',
					file,
					// @ts-expect-error - why?
					message: {
						// Translate from service
						msg: await this.translationService.translateToServerLanguage('pdf_success_message'),
					},
				}),
				// Send the file to the user who requested it, so they can download it
				this.uploadService.sendFileMessage({
					roomId: rid,
					userId: 'rocket.cat',
					file,
					// @ts-expect-error - why?
					message: {
						// Translate from service
						msg: await this.translationService.translate('pdf_success_message', user),
					},
				}),
			]);
			const e = result.find((r) => isPromiseRejectedResult(r));
			if (e && isPromiseRejectedResult(e)) {
				throw e.reason;
			}
		} catch (err) {
			this.log.error({ msg: `Transcript for room ${details.rid} by user ${details.userId} - Failed to send message`, err });
		}
	}
}