import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Set global prefix for all routes
  app.setGlobalPrefix("api/v1");

  // Enable automatic DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strips out properties that don't have decorators
      forbidNonWhitelisted: true, // Throws an error if unknown properties are sent
      transform: true, // Automatically transforms payloads to DTO instances
    }),
  );

  await app.listen(3000);
  console.log(`ReadyOn Time-Off Service is running on: http://localhost:3000`);
}
bootstrap();
