// Reduced from apps/api/src/routes/employees.ts:1366-1372 — req.params validated through a
// locally declared zod schema's `.parse()` call, the other of the two client-supplied-param
// idioms measured in this repo (204-RESEARCH.md §Client-Supplied Identifier Idiom).
declare const z: { object: (shape: unknown) => { parse: (value: unknown) => { id: string } } };
declare const app: { prisma: { presenceDevice: { findUnique: (args: unknown) => unknown } } };

const deviceIdParamSchema = z.object({ id: "uuid" });

export async function removeWifiDeviceHandler(req: { params: unknown }) {
  const { id } = deviceIdParamSchema.parse(req.params);
  const device = await app.prisma.presenceDevice.findUnique({
    where: { id },
  });
  return device;
}
