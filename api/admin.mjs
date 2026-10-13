import { createAdminHandler } from '../server/admin-handler.mjs';
import { respondWithHandler } from '../server/node-adapter.mjs';

const handle = createAdminHandler();

export default function handler(req, res) {
    return respondWithHandler(req, res, handle);
}
