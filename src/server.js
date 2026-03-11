const app = require('./app');
const { port, runApi, runConsumer } = require('./config');
const { startConsumer } = require('./queue/streamConsumer');
const logger = require('./utils/logger');

async function bootstrap() {
  if (!runApi && !runConsumer) {
    logger.error('Invalid runtime role configuration: RUN_API and RUN_CONSUMER are both disabled');
    process.exit(1);
  }

  if (runApi) {
    app.listen(port, () => {
      logger.info({ port }, 'Email API listening');
    });
  } else {
    logger.info('RUN_API=false, skipping HTTP server startup');
  }

  if (runConsumer) {
    await startConsumer();
  } else {
    logger.info('RUN_CONSUMER=false, skipping stream consumer startup');
  }
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Service bootstrap failed');
  process.exit(1);
});
