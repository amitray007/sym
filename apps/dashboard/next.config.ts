import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Skip the pages-router static 404/500 prerendering — we use App Router only.
  // This avoids the "<Html> outside _document" error in Next 15.
  skipTrailingSlashRedirect: false,
};

export default nextConfig;
