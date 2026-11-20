import { handleApi } from '../../server/nb-api.js';
export const onRequest = (ctx) => handleApi(ctx);
