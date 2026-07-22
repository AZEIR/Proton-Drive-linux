import { runSync } from '../sync/index';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8085;
runSync(port).catch(console.error);
