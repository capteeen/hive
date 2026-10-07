import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}', './themes/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        night: 'rgb(var(--c-base) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        soft: 'rgb(var(--c-soft) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        royal: 'rgb(var(--c-royal) / <alpha-value>)',
        starving: 'rgb(var(--c-starving) / <alpha-value>)',
        raid: 'rgb(var(--c-raid) / <alpha-value>)',
      },
      fontFamily: {
        heading: 'var(--f-heading)',
        body: 'var(--f-body)',
      },
      transitionTimingFunction: {
        viscous: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      transitionDuration: {
        600: '600ms',
        900: '900ms',
      },
      boxShadow: {
        honey: '0 0 0 1px rgb(var(--c-accent) / 0.2), inset 0 0 24px rgb(var(--c-accent) / 0.08), 0 20px 60px -20px rgb(var(--c-accent) / 0.35)',
        lift: '0 24px 48px -16px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(var(--c-accent) / 0.35)',
      },
    },
  },
  plugins: [],
};
export default config;
