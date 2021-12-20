module.exports = {
    clearMocks: true,
    moduleFileExtensions: ['ts', 'js'],
    roots: ['<rootDir>/tests/'],
    testEnvironment: 'node',
    transform: {
      '^.+\\.ts?$': 'ts-jest',
    },
    setupFilesAfterEnv: ['jest-extended'],
    globals: {
      'ts-jest': {
        diagnostics: false,
      },
    },
    moduleNameMapper: {
      '^jose/(.*)$': '<rootDir>/node_modules/jose/dist/node/cjs/$1',
    },
    globalSetup: '<rootDir>/tests/global-setup.ts',
    globalTeardown: '<rootDir>/tests/global-teardown.ts',
    testTimeout: 60000,
  }
