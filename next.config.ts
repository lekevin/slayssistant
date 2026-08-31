import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // data/index/*.bin and chunks.json are read at request time from the
  // filesystem, so the chat route must run on Node, not Edge.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/index/**"],
  },
};

export default nextConfig;
