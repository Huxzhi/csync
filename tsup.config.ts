import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/github': 'src/adapters/github.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
})
