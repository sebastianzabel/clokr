import { buildApp } from "./app";
import { config } from "./config";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    app.log.info(`API läuft auf http://${config.API_HOST}:${config.API_PORT}`);
    app.log.info(`Swagger UI: http://${config.API_HOST}:${config.API_PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
