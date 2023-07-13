import type { BaseLogger } from 'pino';

import { Logger } from '../../../../../../../apps/meteor/server/lib/logger/Logger';

const logger = new Logger('Federation_Matrix');

export const federationBridgeLogger: BaseLogger = logger.section('matrix_federation_bridge');
