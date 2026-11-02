// Recorded-SHAPE fixtures for X_AVM-DE_GetSpecificHostEntryByIP (Issue #610).
//
// These strings encode ASSUMPTIONS, not a capture from a real FRITZ!Box (research A1, A2, A5):
//   A1  the action answers NewMACAddress, NewHostName, NewActive and NewInterfaceType;
//   A2  "no host with this IP" is an HTTP 500 SOAP fault with <errorCode>714</errorCode>;
//   A5  NewInterfaceType is "802.11" for a Wi-Fi client.
// The real box confirms or corrects them in the Abnahme (`node dist/probe-host.js <ip>`); until
// then these fixtures are the contract the parser is written against.

const URN = "urn:dslforum-org:service:Hosts:1";

function envelope(fields: Record<string, string | undefined>): string {
  const inner = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("");
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:X_AVM-DE_GetSpecificHostEntryByIPResponse xmlns:u="${URN}">${inner}</u:X_AVM-DE_GetSpecificHostEntryByIPResponse></s:Body>
</s:Envelope>`;
}

function fault(code: number, description: string): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:dslforum-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body>
</s:Envelope>`;
}

export const SOAP_ACTION = `${URN}#X_AVM-DE_GetSpecificHostEntryByIP`;
export const CONTROL_PATH = "/upnp/control/Hosts";

export const HOST_FOUND_WIFI = envelope({
  NewIPAddress: "192.168.178.42",
  NewMACAddress: "AA:BB:CC:00:11:22",
  NewHostName: "iPhone",
  NewActive: "1",
  NewInterfaceType: "802.11",
});

export const HOST_INACTIVE = envelope({
  NewMACAddress: "AA:BB:CC:00:11:22",
  NewHostName: "iPhone",
  NewActive: "0",
  NewInterfaceType: "802.11",
});

export const HOST_NO_INTERFACE_TYPE = envelope({
  NewMACAddress: "AA:BB:CC:00:11:22",
  NewHostName: "iPhone",
  NewActive: "1",
});

export const HOST_ETHERNET = envelope({
  NewMACAddress: "AA:BB:CC:00:11:22",
  NewHostName: "Desktop",
  NewActive: "1",
  NewInterfaceType: "Ethernet",
});

export const HOST_BAD_MAC = envelope({
  NewMACAddress: "not-a-mac",
  NewHostName: "iPhone",
  NewActive: "1",
  NewInterfaceType: "802.11",
});

export const FAULT_714 = fault(714, "NoSuchEntryInArray");

// A fault body longer than the 200 characters an error message keeps, so a test can tell the
// message snippet from the full body.
export const FAULT_402 = fault(402, `Invalid Args ${"x".repeat(400)}`);

export const DIGEST_CHALLENGE =
  'Digest realm="F!Box SOAP-Auth", nonce="0123456789abcdef", qop="auth"';
