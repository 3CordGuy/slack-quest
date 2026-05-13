declare module "@3d-dice/dice-box" {
  interface DiceBoxOptions {
    assetPath?: string;
    theme?: string;
    scale?: number;
    gravity?: number;
    mass?: number;
    friction?: number;
    restitution?: number;
    angularDamping?: number;
    linearDamping?: number;
    spinForce?: number;
    throwForce?: number;
    startingHeight?: number;
    settleTimeout?: number;
    offscreen?: boolean;
    delay?: number;
    enableShadows?: boolean;
    shadowTransparency?: number;
    lightIntensity?: number;
    [key: string]: unknown;
  }

  export default class DiceBox {
    constructor(selector: string | HTMLElement, options?: DiceBoxOptions);
    init(): Promise<DiceBox>;
    roll(notation: string | string[]): Promise<unknown>;
    add(notation: string | string[]): Promise<unknown>;
    reroll(notation: string | string[]): Promise<unknown>;
    remove(notation: string | string[]): void;
    clear(): void;
    hide(): void;
    show(): void;
    destroy(): void;
  }
}
