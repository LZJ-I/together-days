import { createCommentHandler } from '../server/comment-handler.mjs';
import { respondWithHandler } from '../server/node-adapter.mjs';

const handle = createCommentHandler();
export default function handler(req, res) { return respondWithHandler(req, res, handle); }
