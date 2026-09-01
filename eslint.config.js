import tseslint from 'typescript-eslint';

/* The import ban is the single most load-bearing lint rule in the project:
   pulling from bare `three` instead of `three/webgpu` silently drags in the
   WebGL renderer and every TSL node stops resolving. */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.attic/**', 'dev-dist/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tools/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'three',
          message: 'Import from three/webgpu, three/tsl or three/addons/* -- never bare three.',
        }],
        patterns: [{
          group: ['three/src/*', 'three/build/*'],
          message: 'Use the three/webgpu, three/tsl or three/addons/* entry points.',
        }],
      }],
      'no-restricted-globals': ['error',
        { name: 'requestAnimationFrame', message: 'One rAF loop exists, in src/core/Engine.ts. Subscribe to it instead.' },
      ],
    },
  },
);
