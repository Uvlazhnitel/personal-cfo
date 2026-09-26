import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Personal CFO',
    short_name: 'CFO',
    description: 'A private, decision-oriented personal finance dashboard.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f3f5f1',
    theme_color: '#17201b',
  };
}
