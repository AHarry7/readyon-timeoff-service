import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * Mock HCM Server
 *
 * Starts on PORT env var (default 4001) so it can run alongside the
 * main ReadyOn microservice (default 3000) during integration tests.
 *
 * The server deliberately has NO authentication — it is for test use only.
 * Do not deploy this to any real environment.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
  });

  const port = parseInt(process.env.PORT ?? "4001", 10);
  await app.listen(port);

  console.log(`[MockHCM] Listening on http://localhost:${port}`);
  console.log(
    `[MockHCM] Control plane: POST http://localhost:${port}/mock/config`,
  );
  console.log(
    `[MockHCM] Reset state:   POST http://localhost:${port}/mock/reset`,
  );
  console.log(
    `[MockHCM] Telemetry:     GET  http://localhost:${port}/mock/telemetry`,
  );
}

bootstrap();
