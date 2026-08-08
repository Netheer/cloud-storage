import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const configService = app.get(ConfigService);
  app.enableShutdownHooks();

  app.enableCors({
    origin: configService.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Cloud Storage API')
    .setDescription('Backend API for the cloud file storage application.')
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      'access-token',
    )
    .build();

  const documentFactory = () =>
    SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, documentFactory, {
    jsonDocumentUrl: 'docs/json',
    customSiteTitle: 'Cloud Storage API',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
