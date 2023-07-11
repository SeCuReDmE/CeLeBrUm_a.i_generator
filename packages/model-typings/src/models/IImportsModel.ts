import type { UpdateResult, FindOptions, FindCursor, Document } from 'mongodb';
import type { IImport } from '@rocket.chat/core-typings';

import type { IBaseModel } from './IBaseModel';

export interface IImportsModel extends IBaseModel<IImport> {
	findLastImport(): Promise<any | undefined>;
	hasValidOperationInStatus(allowedStatus: IImport['status'][]): Promise<boolean>;
	invalidateAllOperations(): Promise<UpdateResult | Document>;
	invalidateOperationsExceptId(id: string): Promise<UpdateResult | Document>;
	invalidateOperationsNotInStatus(status: string | string[]): Promise<UpdateResult | Document>;
	findAllPendingOperations(options: FindOptions<any>): FindCursor<any>;
}
