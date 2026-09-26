declare module "screenshot-desktop" {
  interface Options {
    format?: "png" | "jpg" | "jpeg" | "bmp";
    screen?: string | number;
  }
  function screenshot(options?: Options): Promise<Buffer>;
  export default screenshot;
}
