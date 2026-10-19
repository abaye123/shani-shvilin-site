/**
 * Build-time QR image for Android QR provisioning: /qr/device-owner.png.
 * Generated only when the published release has a signing certificate; no runtime code.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import QRCode from "qrcode";
import { buildProvisioningPayload, isSha256Hex } from "@shani/installer-core";
import { stable } from "../../lib/site-data";

export const getStaticPaths: GetStaticPaths = () => {
  const cert = stable?.info.certSha256;
  return isSha256Hex(cert) ? [{ params: { name: "device-owner" }, props: { cert } }] : [];
};

export const GET: APIRoute = async ({ props }) => {
  const payload = JSON.stringify(buildProvisioningPayload(props.cert as string));
  const png = await QRCode.toBuffer(payload, { errorCorrectionLevel: "M", margin: 2, width: 640 });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
