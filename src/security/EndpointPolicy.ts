import { StructuredError } from "@/domain/errors";

export interface EndpointApproval {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
}
export interface EndpointPolicyOptions {
  readonly approvals?: readonly EndpointApproval[];
}

/** Validates and canonicalizes local LM Studio endpoints and their trust boundary. */
export class EndpointPolicy {
  private readonly approvals: ReadonlySet<string>;
  constructor(options: EndpointPolicyOptions = {}) {
    this.approvals = new Set((options.approvals ?? []).map((value) => this.originKey(value)));
  }
  /** Returns the canonical origin plus `/v1`, or throws a stable invalid-request error. */
  normalize(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw this.invalid("Endpoint must be a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw this.invalid("Endpoint must use http or https.");
    if (url.username || url.password || url.search || url.hash)
      throw this.invalid("Endpoint cannot contain credentials, a query, or a fragment.");
    const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (!this.isAllowedHost(host))
      throw this.invalid(
        "Only literal loopback or explicitly approved private addresses are allowed."
      );
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const key = this.originKey({
      scheme: url.protocol.slice(0, -1) as "http" | "https",
      host,
      port,
    });
    if (!this.isAutomaticHost(host) && !this.approvals.has(key))
      throw this.invalid("This private address must be explicitly approved first.");
    if (
      url.pathname !== "" &&
      url.pathname !== "/" &&
      url.pathname !== "/v1" &&
      url.pathname !== "/v1/"
    )
      throw this.invalid("Endpoint path must be empty or /v1.");
    return `${url.protocol}//${this.formatHost(host)}${url.port ? `:${port}` : ""}/v1`;
  }
  /** Normalizes an endpoint and returns its approval identity for persistence. */
  approvalFor(raw: string): EndpointApproval {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw this.invalid("Endpoint must be a valid URL.");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw this.invalid("Endpoint must use a valid, credential-free http or https URL.");
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    if (!this.isAllowedHost(host)) throw this.invalid("Only private addresses can be approved.");
    if (
      url.pathname !== "" &&
      url.pathname !== "/" &&
      url.pathname !== "/v1" &&
      url.pathname !== "/v1/"
    )
      throw this.invalid("Endpoint path must be empty or /v1.");
    return {
      scheme: url.protocol.slice(0, -1) as "http" | "https",
      host,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }
  private originKey(value: EndpointApproval): string {
    return `${value.scheme}://${value.host.toLowerCase()}:${value.port}`;
  }
  private isAllowedHost(host: string): boolean {
    return (
      this.isAutomaticHost(host) ||
      (this.isIpv4(host) ? this.isPrivateIpv4(host) : this.isIpv6(host) && this.isPrivateIpv6(host))
    );
  }
  private isAutomaticHost(host: string): boolean {
    return host === "::1" || (this.isIpv4(host) && host.startsWith("127."));
  }
  private isIpv4(host: string): boolean {
    const parts = host.split(".");
    return (
      parts.length === 4 &&
      parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    );
  }
  private isPrivateIpv4(host: string): boolean {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  private isIpv6(host: string): boolean {
    return host.includes(":") && /^[0-9a-f:]+$/i.test(host) && host.split(":").length <= 8;
  }
  private isPrivateIpv6(host: string): boolean {
    const value = host.toLowerCase();
    return (
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb")
    );
  }
  private formatHost(host: string): string {
    return this.isIpv6(host) ? `[${host}]` : host;
  }
  private invalid(message: string): StructuredError {
    return new StructuredError("invalid_request", message, false);
  }
}
