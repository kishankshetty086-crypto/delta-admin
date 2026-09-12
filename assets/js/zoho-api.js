/**
 * Zoho API & Third-party Services Client
 * Automatically connects to local proxy (http://localhost:3500) to ensure zero CORS blocking,
 * whether loaded via http://localhost:3500 or directly via file:// protocol.
 */

class ZohoApiClient {
  constructor(config) {
    this.config = config || window.APP_CONFIG || window.DEFAULT_CONFIG;
    this.apiBase = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3500';
  }

  updateConfig(newConfig) {
    this.config = newConfig;
  }

  /**
   * 1. Get Zoho Access Token
   */
  async getAccessToken(forceRefresh = false) {
    try {
      const res = await fetch(`${this.apiBase}/api/zoho/token`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.access_token) return data.access_token;
      }
    } catch (e) {
      console.warn("Local bridge not reachable, trying direct OAuth:", e);
    }

    const { clientId, clientSecret, refreshToken, tokenUrl } = this.config.zoho;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: (clientId || '').trim(),
      client_secret: (clientSecret || '').trim(),
      refresh_token: (refreshToken || '').trim()
    });

    const response = await fetch(tokenUrl || "https://accounts.zoho.in/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    const data = await response.json();
    if (data.access_token) return data.access_token;
    throw new Error(data.error || 'Failed to refresh token');
  }

  /**
   * 2. Availability API Fetcher (Real Data)
   */
  async fetchAvailability() {
    try {
      const response = await fetch(`${this.apiBase}/api/availability`, {
        method: 'GET',
        headers: {
          'accept': '*/*',
          'cache-control': 'no-cache',
          'pragma': 'no-cache'
        }
      });

      if (response.ok) {
        const raw = await response.json();
        return this.parseAvailabilityResponse(raw);
      }
    } catch (err) {
      console.warn("Proxy availability fetch failed, trying direct endpoint:", err);
    }

    // Direct endpoint attempt
    const baseUrl = this.config.availability?.apiUrl || "https://madhava.kambala.co.in/deltabaavailability/api/availability/";
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'accept': '*/*' }
    });

    if (!response.ok) {
      throw new Error(`Availability API responded with HTTP ${response.status}`);
    }

    const raw = await response.json();
    return this.parseAvailabilityResponse(raw);
  }

  parseAvailabilityResponse(data) {
    if (!data || !data.range_details || !Array.isArray(data.range_details)) {
      return { raw: data, users: [], status: data?.status || "error" };
    }

    const rows = data.range_details;
    if (rows.length <= 1) {
      return { raw: data, users: [], status: "empty" };
    }

    const users = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const details = row.row_details || [];
      const colMap = {};
      details.forEach(col => {
        colMap[col.column_index] = col.content || "";
      });

      const name = (colMap[1] || "").trim();
      const availability = (colMap[2] || "").trim();
      const phone = (colMap[3] || "").trim();

      if (name) {
        users.push({
          rowIndex: row.row_index || (i + 1),
          name: name,
          availability: availability || "Unknown",
          phone: phone,
          isEscalation: availability.toLowerCase().includes("escalation"),
          isAvailable: availability.toLowerCase().includes("available") && !availability.toLowerCase().includes("not available")
        });
      }
    }

    return {
      raw: data,
      users: users,
      status: data.status || "success",
      usedRow: data.used_row || users.length,
      timestamp: new Date()
    };
  }

  /**
   * 3. Zoho Sheets API: Call Sheet Method
   */
  async callSheetApi(sheetId, method, extraParams = {}) {
    let responseData = null;
    let statusCode = 200;

    try {
      const res = await fetch(`${this.apiBase}/api/zoho/sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetId, method, params: extraParams })
      });
      statusCode = res.status;
      responseData = await res.json().catch(() => null);
    } catch (e) {
      console.warn("Local proxy sheet call network error:", e);
      throw new Error(`Network error connecting to local server at ${this.apiBase || 'http://localhost:3500'}`);
    }

    if (responseData) {
      if (responseData.error_message) {
        if (responseData.error_code === 2403 || responseData.error_message.includes('OAuth scope')) {
          throw new Error(`OAuth Scope Limitation: Token lacks write permission (${responseData.error_message}). Scope 'ZohoSheet.dataAPI.ALL' is required for sheet modifications.`);
        }
        throw new Error(responseData.error_message);
      }
      return responseData;
    }

    throw new Error(`HTTP ${statusCode} returned with empty response from Zoho Sheet proxy`);
  }

  async getWorksheetRecords(sheetId, worksheetName) {
    return await this.callSheetApi(sheetId, "worksheet.content.get", {
      worksheet_name: worksheetName
    });
  }

  async appendWorksheetRecords(sheetId, worksheetName, recordsArray, headerRow = 2) {
    if (!recordsArray || recordsArray.length === 0) return { status: "success", count: 0 };
    return await this.callSheetApi(sheetId, "worksheet.records.add", {
      worksheet_name: worksheetName,
      header_row: headerRow,
      json_data: typeof recordsArray === 'string' ? recordsArray : JSON.stringify(recordsArray)
    });
  }

  async deleteWorksheetRows(sheetId, worksheetName, startRowIndex = 3, endRowIndex = 3) {
    const endRow = endRowIndex || startRowIndex;
    return await this.callSheetApi(sheetId, "worksheet.rows.delete", {
      worksheet_name: worksheetName,
      row_index_array: JSON.stringify([{ start_row: startRowIndex, end_row: endRow }])
    });
  }

  /**
   * 4. Post Message to Zoho Cliq Webhook
   */
  async sendCliqMessage(messageText) {
    const webhookUrl = this.config.cliq?.webhookUrl;
    try {
      const res = await fetch(`${this.apiBase}/api/cliq/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl, text: messageText })
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn("Proxy Cliq send failed, trying direct webhook:", e);
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: messageText })
    });
    return true;
  }
}

window.ZohoApiClient = ZohoApiClient;