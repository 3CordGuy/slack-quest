// What the player sees when the game itself fails: a few plain words and a way back, rather than an
// empty page. It stands round the whole app (main.tsx), so it uses no game state and nothing that draws.

import { Component, type ReactNode } from "react";
import { GRAPHICS_HELP, GraphicsUnavailable } from "./render/graphics";

interface State {
  error: unknown;
}

export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const graphics = error instanceof GraphicsUnavailable;
    return (
      <div className="crash" role="alert">
        <section className="panel crash-panel">
          <h2>{graphics ? "The game could not start its graphics" : "Something went wrong"}</h2>
          {graphics ? (
            <>
              <p>Your browser did not give the game a working 3D canvas (WebGL), so there is nothing to draw the Harbor with.</p>
              <p>{GRAPHICS_HELP}</p>
            </>
          ) : (
            <>
              <p>The game hit a problem it could not carry on from. Your hero is safe: nothing here is lost by loading the page again.</p>
              <p className="muted crash-detail">{error instanceof Error ? error.message : String(error)}</p>
            </>
          )}
          <button className="primary big" onClick={() => location.reload()}>Load the game again</button>
        </section>
      </div>
    );
  }
}
