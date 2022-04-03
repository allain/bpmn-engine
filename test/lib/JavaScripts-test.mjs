"use strict";

import JavaScripts from "../../lib/JavaScripts.mjs";

describe("JavaScripts", () => {
  it("can be invoked without new", () => {
    const js = new JavaScripts();
    expect(js).to.be.instanceOf(JavaScripts);
  });
});
