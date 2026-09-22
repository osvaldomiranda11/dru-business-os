module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/services'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@dru-bos/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
  clearMocks: true,
};