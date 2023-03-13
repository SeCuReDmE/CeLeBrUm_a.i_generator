import type { IRole } from '@rocket.chat/core-typings';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

import { rolesStreamer } from '../../app/authorization/client/lib/streamer';
import { Roles } from '../../app/models/client';
import { CachedCollectionManager } from '../../app/ui-cached-collection/client';
import { APIClient } from '../../app/utils/client/lib/RestApiClient';

Meteor.startup(() => {
	CachedCollectionManager.onLogin(async () => {
		const { roles } = await APIClient.get('/v1/roles.list');
		// if a role is checked before this collection is populated, it will return undefined
		Roles._collection._docs._map = new Map(roles.map((record) => [Roles._collection._docs._idStringify(record._id), record]));
		Object.values(Roles._collection.queries).forEach((query) => Roles._collection._recomputeResults(query));

		Roles.ready.set(true);
	});

	const events = {
		changed: (role: IRole & { type?: 'changed' | 'removed' }) => {
			delete role.type;
			Roles.upsert({ _id: role._id }, role);
		},
		removed: (role: IRole) => {
			Roles.remove({ _id: role._id });
		},
	} as const;

	Tracker.autorun((c) => {
		if (!Meteor.userId()) {
			return;
		}
		rolesStreamer.on('roles', (role: IRole & { type: 'changed' | 'removed' }) => events[role.type](role));
		c.stop();
	});
});