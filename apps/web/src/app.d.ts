declare const __APP_VERSION__: string;

declare global {
  namespace App {
    interface Locals {
      nonce: string;
    }
  }
}
