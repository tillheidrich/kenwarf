import { starteServer } from './index.js';

const laufend = await starteServer();
const ende = async () => {
  await laufend.stop();
  process.exit(0);
};
process.on('SIGINT', ende);
process.on('SIGTERM', ende);
