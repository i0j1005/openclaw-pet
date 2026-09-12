import type { PetApi } from "../preload/index";

declare global {
  interface Window {
    pet: PetApi;
  }
}

export {};
