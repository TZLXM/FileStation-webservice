import { openWindowsFile, WindowsApi } from "./platform-file";
function fake(attributes = 0) {
  const calls: any[] = [];
  let sequence = 0;
  const api: WindowsApi = {
    create(p, a, s, d, f) {
      const h = { p, a, s, d, f, id: ++sequence };
      calls.push(h);
      return h;
    },
    info(h: any) {
      return {
        attributes: h.p.endsWith("source") ? attributes : 0x10,
        volume: 3,
        indexHigh: 0,
        indexLow: h.id,
        sizeHigh: 0,
        sizeLow: 2,
        links: 1,
      };
    },
    read: jest.fn(() => Buffer.from("ok")),
    write: jest.fn((_, b) => b.length),
    close: jest.fn(),
  };
  return { api, calls };
}
describe("Win32 adapter contract (injected, separate from real host archive tests)", () => {
  test("uses OPEN_REPARSE_POINT on every component and denies delete/write sharing", async () => {
    const { api, calls } = fake();
    const f = await openWindowsFile("C:\\stage\\source", false, api);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.f & 0x200000).toBeTruthy();
      expect(c.s & 4).toBe(0);
    }
    expect(calls[2].a).toBe(0x80000000);
    expect(calls[2].d).toBe(3);
    expect(await f.identity()).toEqual({
      id: "3:0:3",
      size: 2,
      directory: false,
    });
    expect(await f.read(0, 2)).toEqual(Buffer.from("ok"));
    await f.close();
    expect(api.close).toHaveBeenCalledTimes(3);
    await expect(f.read(0, 2)).rejects.toThrow();
  });
  test("rejects reparse attribute on the opened source before reading and closes handles", async () => {
    const { api } = fake(0x400);
    await expect(
      openWindowsFile("C:\\stage\\source", false, api),
    ).rejects.toThrow("reparse");
    expect(api.read).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledTimes(3);
  });
  test("rejects ancestor reparse and does not open leaf", async () => {
    const { api, calls } = fake();
    api.info = () => ({
      attributes: 0x410,
      volume: 0,
      indexHigh: 0,
      indexLow: 0,
      sizeHigh: 0,
      sizeLow: 0,
      links: 1,
    });
    await expect(
      openWindowsFile("C:\\stage\\source", false, api),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  test("output uses exclusive CREATE_NEW and write access", async () => {
    const { api, calls } = fake();
    const f = await openWindowsFile("C:\\stage\\source", true, api);
    expect(calls[2].d).toBe(1);
    expect(calls[2].a).toBe(0x40000000);
    await f.write(Buffer.from("ok"));
    expect(api.write).toHaveBeenCalledTimes(1);
    await f.close();
  });
});
