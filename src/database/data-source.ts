import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  createDatabaseOptions,
  validateDatabaseEnvironment,
} from '../config/database.config';

const environment = validateDatabaseEnvironment(process.env);
const configService = new ConfigService(environment);

const dataSource = new DataSource(createDatabaseOptions(configService));

export default dataSource;
