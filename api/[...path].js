// Vercel serverless entry: every /api/* request goes through the same handler as the local server.
import { handleApi } from '../server/api.js';

export default handleApi;
