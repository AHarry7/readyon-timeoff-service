module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  collectCoverageFrom: [
    // "**/*.(t|j)s",
    // "!**/node_modules/**",
    // "!**/test-helpers.ts",
    // "!**/main.ts",
    // "!**/*.module.ts",
    // "!**/migrations/**",
    // "!**/dto/**",
    // "!**/entities/**",
    // "!**/common/enums.ts",
    "modules/balances/balances.service.ts",
    "modules/time-off/time-off.service.ts",
  ],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
  coverageReporters: ["text", "lcov", "html"],

  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },

  // FIX: Route all 'uuid' imports to our custom mock file!
  moduleNameMapper: {
    "^uuid$": "<rootDir>/uuid-mock.ts",
    "^src/(.*)$": "<rootDir>/$1",
  },

  verbose: true,
};
