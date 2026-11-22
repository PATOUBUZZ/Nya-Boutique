import { handleImage } from '../../server/nb-api.js';
export const onRequest = (ctx) => handleImage(ctx);
