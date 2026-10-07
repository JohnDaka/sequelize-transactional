/**
 * `@Transactional()` for Sequelize without injecting a connection into every service: register
 * the app's connection once, decorate the methods that write, and nested calls join one
 * transaction. `currentTransaction()` reaches it from anywhere in the call chain, and the
 * database clock (`databaseNow()`, `readDatabaseNow()`) is one "now" for every app server.
 *
 * @packageDocumentation
 */
export * from './transactional.ts';
export * from './database-clock.ts';
export * from './errors.ts';
