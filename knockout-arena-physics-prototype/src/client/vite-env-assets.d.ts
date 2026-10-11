/**
 * Bundled asset modules (Vite): importing an image yields its URL —
 * inlined as a data URI by vite-plugin-singlefile in the production
 * build (the server answers / with one file and 404s every other path,
 * so separate asset files would be guaranteed 404s — same reason the
 * favicons are inline).
 */
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
