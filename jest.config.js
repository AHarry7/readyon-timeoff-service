// jest.config.js — place in the project root alongside package.json
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!**/node_modules/**',
    '!**/__tests__/test-helpers.ts',
    '!**/main.ts',
    '!**/*.module.ts',
    '!**/migrations/**',
    '!**/dto/**',
    '!**/entities/**',
    '!**/common/enums.ts',
  ],
  coverageDirectory: '../coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThresholds: {
    // Enforced at CI level — a PR that drops below these thresholds fails.
    global: {
      branches:   80,
      functions:  90,
      lines:      90,
      statements: 90,
    },
  },
  testEnvironment: 'node',

  // Verbose output shows each test name — useful in CI logs.
  verbose: true,
};

/*
──────────────────────────────────────────────────────────────────────────────
Add these scripts to package.json:
──────────────────────────────────────────────────────────────────────────────

  "scripts": {
    "test":            "jest",
    "test:watch":      "jest --watch",
    "test:coverage":   "jest --coverage",
    "test:unit":       "jest --testPathPattern=__tests__",
    "test:e2e":        "jest --config ./test/jest-e2e.json"
  }

──────────────────────────────────────────────────────────────────────────────
Required devDependencies (add via npm install -D):
──────────────────────────────────────────────────────────────────────────────

  @nestjs/testing
  jest
  ts-jest
  @types/jest

──────────────────────────────────────────────────────────────────────────────
Run the tests:
──────────────────────────────────────────────────────────────────────────────

  npm run test:coverage

*/
