import { spawn } from "child_process";
import log from "../../log";

/**
 * Fetches all Meta/Facebook IP addresses from RADB database
 * Works on both Windows and Linux using native HTTP requests
 *
 * @returns {Promise<string[]>} Array of IP addresses
 */
export async function getMetaIpAddresses(): Promise<string[]> {
  try {
    log.debug("Fetching Meta IP addresses using HTTP request");

    // Use native fetch to query the RADB HTTP interface
    const response = await fetch(
      "https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS32934"
    );

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data = await response.json();

    // Extract IP addresses from the JSON response
    const ipAddresses = data.data.prefixes
      .map((prefix: { prefix: string }) => prefix.prefix)
      .sort();

    // Log the IP addresses to console
    log.debug(`Retrieved ${ipAddresses.length} Meta IP addresses`);

    return ipAddresses;
  } catch (error) {
    log.error(`Failed to fetch Meta IP addresses: ${error}`);
    return [];
  }
}
