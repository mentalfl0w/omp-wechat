declare module "qrcode-terminal" {
  const qt: {
    generate: (text: string, options?: { small?: boolean }) => void;
  };
  export default qt;
}
