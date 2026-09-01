import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // data/index/*.bin and chunks.json are read at request time from the
  // filesystem, so the chat route must run on Node, not Edge.
  //
  // Tracing is per-route. /api/rulebook-info reads the manifest and the parse
  // metadata, and without its own entry those files are absent from that
  // lambda's bundle: the route falls into its catch and reports
  // `ready: false, "Index not built"`, so a correctly deployed app shows a
  // broken header. It fails soft, which is exactly why it would have shipped
  // unnoticed.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/index/**"],
    "/api/rulebook-info": ["./data/index/manifest.json", "./data/parsed/rulebook.meta.json"],
  },
};

export default nextConfig;
