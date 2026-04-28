/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      // -----------------------------------------------------------------
      // Honeycomb brand palette (FINAL_Honeycomb_Brand_Guide_Aug_2024).
      // Yellow is the dominant brand color. Cream/white are interchangeable
      // backgrounds. Purple + light blue are main accents. Green is sparing.
      // Dark brown is RESERVED for logo applications and is intentionally
      // excluded from the UI palette.
      // -----------------------------------------------------------------
      colors: {
        honeycomb: {
          yellow: '#FFDE17',
          cream: '#F6F3E5',
          purple: '#3F296B',
          blue: '#D9ECFF',
          green: '#59B16B',
          ink: '#222222',
        },
      },
      fontFamily: {
        // Raleway: large headlines (per brand guide page 9).
        display: ['Raleway', 'system-ui', 'sans-serif'],
        // Open Sans: subheaders and body (per brand guide page 9).
        sans: ['"Open Sans"', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        // Cream-to-white gradient called out in brand-guide style elements.
        'honeycomb-fade': 'linear-gradient(180deg, #F6F3E5 0%, #FFFFFF 100%)',
      },
    },
  },
  plugins: [],
};
