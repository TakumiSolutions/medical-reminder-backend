import knexFactory from 'knex';
import { knexConfig } from './knexConfig.js';

export const db = knexFactory(knexConfig);
