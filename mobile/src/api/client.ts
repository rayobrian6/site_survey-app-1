/**
 * api/client.ts
 *
 * Typed fetch wrappers for the Site Survey backend.
 * In development the server runs on localhost:3001.
 * In production set EXPO_PUBLIC_API_URL in your Expo environment.
 */
import Constants from "expo-constants";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  Survey,
  SurveyFormData,
  ApiSyncResponse,
  ApiPhotoUploadResponse,
  ARDetectionPayload,
  ARDetectionResponse,
  ARDetectionListResponse,
  PhotoInferenceRequest,
  PhotoInferenceResponse,
} from "../types";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "user";
  createdAt: string;
  username?: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string | null;
  user: AuthUser;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
}

export interface ForgotPasswordResponse {
  message: string;
  delivery?: "sent" | "failed";
  resetToken?: string;
  expiresInMinutes?: number;
}

// ----------------------------------------------------------------
// Engineering Report types (mirrors backend/src/utils/reportGenerator.ts)
// ----------------------------------------------------------------

export type FlagPriority = "High" | "Medium" | "Low";
export type OverallRisk = "High" | "Medium" | "Low" | "None";

export interface ReportFlag {
  priority: FlagPriority;
  category: string;
  field?: string;
  message: string;
}

export interface ChecklistSummary {
  total: number;
  pass: number;
  fail: number;
  na: number;
  pending: number;
}

export interface EngineeringReport {
  survey_id: string;
  project_name: string;
  site_name: string;
  site_address: string | null;
  inspector_name: string;
  category: string | null;
  latitude: number | null;
  longitude: number | null;
  survey_date: string;
  generated_at: string;
  overall_risk: OverallRisk;
  flags: ReportFlag[];
  checklist_summary: ChecklistSummary;
  recommendations: string[];
  metadata: Record<string, unknown> | null;
}

type ExpoConstantsConfig = {
  expoConfig?: {
    hostUri?: string;
    extra?: {
      apiUrl?: string;
    };
  };
  expoGoConfig?: { debuggerHost?: string };
};

const isDevelopmentRuntime =
  typeof __DEV__ !== "undefined"
    ? __DEV__
    : process.env.NODE_ENV !== "production";

function normalizeApiUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/\/$/, "");
  return normalized.length > 0 ? normalized : null;
}

function readExpoExtraApiUrl(): string | null {
  const config = Constants as unknown as ExpoConstantsConfig;
  return normalizeApiUrl(config.expoConfig?.extra?.apiUrl);
}

function inferLanApiUrlFromExpoHost(): string | null {
  const config = Constants as unknown as ExpoConstantsConfig;

  const hostUriRaw =
    config.expoConfig?.hostUri ?? config.expoGoConfig?.debuggerHost;
  if (typeof hostUriRaw !== "string" || hostUriRaw.length === 0) return null;

  const host = hostUriRaw.split(":")[0]?.trim();
  if (!host) return null;
  return `http://${host}:3001`;
}

function uniqueStrings(values: Array<string | null>): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

const configuredApiUrl = normalizeApiUrl(process.env.EXPO_PUBLIC_API_URL);

const developmentFallbackCandidates = isDevelopmentRuntime
  ? uniqueStrings([
      readExpoExtraApiUrl(),
      inferLanApiUrlFromExpoHost(),
      Platform.OS === "android" ? "http://10.0.2.2:3001" : null,
      "http://localhost:3001",
    ])
  : [];

export const API_URL = configuredApiUrl ?? developmentFallbackCandidates[0] ?? "";

const API_CANDIDATES = uniqueStrings([
  configuredApiUrl,
  ...developmentFallbackCandidates,
]);

const API_NETWORK_ERROR =
  API_CANDIDATES.length > 0
    ? `Cannot reach API. Tried: ${API_CANDIDATES.join(", ")}.${isDevelopmentRuntime ? " Ensure backend is running and your phone is on the same Wi-Fi as this machine." : ""}`
    : "API is not configured for this build. Set EXPO_PUBLIC_API_URL for your production EAS environment, then rebuild or publish an update.";

function withTimeoutSignal(init: RequestInit, timeoutMs = 5_000): RequestInit {
  if (init.signal || typeof AbortController === "undefined") {
    return init;
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return { ...init, signal: controller.signal };
}

async function fetchWithFallback(
  path: string,
  init: RequestInit,
  options?: { timeoutMs?: number },
): Promise<Response> {
  if (API_CANDIDATES.length === 0) {
    throw new Error(API_NETWORK_ERROR);
  }

  for (const baseUrl of API_CANDIDATES) {
    try {
      return await fetch(
        `${baseUrl}${path}`,
        withTimeoutSignal(init, options?.timeoutMs ?? 5_000),
      );
    } catch {
      // Try next candidate URL.
    }
  }

  throw new Error(API_NETWORK_ERROR);
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const AUTH_TOKEN_KEY = "site-survey.auth.token.v2";
const REFRESH_TOKEN_KEY = "site-survey.auth.refresh-token.v1";

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

async function fetchWithAuthRetry(
  path: string,
  init: RequestInit,
  options?: { timeoutMs?: number },
): Promise<Response> {
  const firstResponse = await fetchWithFallback(path, init, options);
  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  let refreshToken: string | null = null;
  try {
    refreshToken = await AsyncStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    refreshToken = null;
  }

  if (!refreshToken) {
    return firstResponse;
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await AsyncStorage.setItem(AUTH_TOKEN_KEY, refreshed.token);
    await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshed.refreshToken);

    const retryHeaders = new Headers(init.headers as HeadersInit | undefined);
    retryHeaders.set("Authorization", `Bearer ${refreshed.token}`);

    return fetchWithFallback(
      path,
      {
        ...init,
        headers: retryHeaders,
      },
      options,
    );
  } catch {
    return firstResponse;
  }
}

// ----------------------------------------------------------------
// Health
// ----------------------------------------------------------------

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetchWithFallback("/api/health", {});
    return res.ok;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------
// Authentication
// ----------------------------------------------------------------

export async function signIn(
  identifier: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetchWithFallback("/api/users/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  return handleResponse<AuthResponse>(res);
}

export async function register(input: RegisterInput): Promise<AuthResponse> {
  const res = await fetchWithFallback("/api/users/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      full_name: input.fullName,
    }),
  });
  return handleResponse<AuthResponse>(res);
}

export async function forgotPassword(
  email: string,
): Promise<ForgotPasswordResponse> {
  const res = await fetchWithFallback("/api/users/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return handleResponse<ForgotPasswordResponse>(res);
}

export async function resetPassword(
  email: string,
  token: string,
  newPassword: string,
): Promise<{ message: string }> {
  const res = await fetchWithFallback("/api/users/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, token, new_password: newPassword }),
  });
  return handleResponse<{ message: string }>(res);
}

export async function fetchCurrentUser(token: string): Promise<AuthUser> {
  const res = await fetchWithFallback("/api/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await handleResponse<{ user: AuthUser }>(res);
  return data.user;
}

// ----------------------------------------------------------------
// Categories
// ----------------------------------------------------------------

export interface ApiCategory {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

export async function fetchCategories(): Promise<ApiCategory[]> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithFallback("/api/categories", {
    headers: authHeaders,
  });
  const data = await handleResponse<{ categories: ApiCategory[] }>(res);
  return data.categories;
}

// ----------------------------------------------------------------
// Surveys
// ----------------------------------------------------------------

/** POST a single survey — used for initial create during sync. */
export async function postSurvey(
  survey: SurveyFormData & { id: string },
): Promise<Survey> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithAuthRetry("/api/surveys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      id: survey.id,
      project_name: survey.project_name,
      category_id: survey.category_id,
      category_name: survey.category_name,
      inspector_name: survey.inspector_name,
      site_name: survey.site_name,
      site_address: survey.site_address,
      latitude: survey.latitude,
      longitude: survey.longitude,
      gps_accuracy: survey.gps_accuracy,
      survey_date: survey.survey_date,
      notes: survey.notes,
      status: "submitted",
      device_id: survey.device_id,
      /** Category-specific metadata (Ground Mount / Roof Mount / Solar Fencing) */
      metadata: survey.metadata ?? null,
      // Checklist items are sent with the survey for atomic creation
      checklist: (survey.checklist ?? []).map((c) => ({
        label: c.label,
        status: c.status,
        notes: c.notes,
      })),
    }),
  });
  return handleResponse<Survey>(res);
}

/**
 * POST /api/surveys/:id/photos — multipart/form-data upload.
 * Accepts an array of { uri, label } objects from expo-image-picker.
 */
export async function uploadPhotos(
  surveyId: string,
  photos: Array<{ uri: string; label: string; mimeType?: string }>,
): Promise<ApiPhotoUploadResponse> {
  const form = new FormData();

  const labels: string[] = [];
  for (const photo of photos) {
    // React Native FormData accepts an object with uri/type/name
    form.append("photos", {
      uri: photo.uri,
      type: photo.mimeType ?? "image/jpeg",
      name: photo.uri.split("/").pop() ?? "photo.jpg",
    } as unknown as Blob);
    labels.push(photo.label);
  }
  form.append("labels", JSON.stringify(labels));

  const authHeaders = await getAuthHeaders();
  const res = await fetchWithAuthRetry(
    `/api/surveys/${surveyId}/photos`,
    {
      method: "POST",
      headers: authHeaders,
      body: form,
      // Do NOT manually set Content-Type — fetch sets it with the boundary
    },
    { timeoutMs: 120_000 },
  );
  return handleResponse<ApiPhotoUploadResponse>(res);
}

/** POST /api/surveys/sync — batch offline sync. */
export async function batchSync(payload: {
  device_id: string;
  surveys: Array<{ action: "create" | "update"; survey: Survey }>;
}): Promise<ApiSyncResponse> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithAuthRetry("/api/surveys/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload),
  });
  return handleResponse<ApiSyncResponse>(res);
}

/** POST /api/surveys/:id/complete — marks survey complete and queues webhook delivery. */
export async function completeSurvey(surveyId: string): Promise<{
  survey_id: string;
  status: string;
  event_id: string;
}> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithAuthRetry(`/api/surveys/${surveyId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({}),
  });
  return handleResponse<{ survey_id: string; status: string; event_id: string }>(res);
}

// ----------------------------------------------------------------
// Engineering Report
// ----------------------------------------------------------------

/**
 * GET /api/surveys/:id/report
 * Returns the EngineeringReport JSON for a survey.
 */
export async function fetchReport(
  surveyId: string,
): Promise<EngineeringReport> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithFallback(`/api/surveys/${surveyId}/report`, {
    headers: authHeaders,
  });
  return handleResponse<EngineeringReport>(res);
}

/**
 * GET /api/surveys/:id/report?format=markdown
 * Downloads the Markdown report text.
 */
export async function downloadReportMarkdown(
  surveyId: string,
): Promise<string> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithFallback(
    `/api/surveys/${surveyId}/report?format=markdown`,
    { headers: authHeaders },
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.text();
}

/**
 * DELETE /api/surveys/:id/report
 * Requests deletion of the Engineering Report for a survey.
 */
export async function deleteReport(
  surveyId: string,
): Promise<{ message: string }> {
  const authHeaders = await getAuthHeaders();
  const res = await fetchWithFallback(`/api/surveys/${surveyId}/report`, {
    method: "DELETE",
    headers: authHeaders,
  });
  return handleResponse<{ message: string }>(res);
}

// ----------------------------------------------------------------
// AR Detection
// ----------------------------------------------------------------

/**
 * POST /api/surveys/:id/ar-detection
 * Submits an AR detection payload for a survey.
 * If a main service panel (class === "panel") is present the backend
 * will auto-escalate the survey to "submitted" (Ready for Engineering)
 * and append a pass checklist item.
 */
export async function submitARDetection(
  surveyId: string,
  payload: ARDetectionPayload,
  token: string,
): Promise<ARDetectionResponse> {
  const res = await fetchWithFallback(`/api/surveys/${surveyId}/ar-detection`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return handleResponse<ARDetectionResponse>(res);
}

/**
 * GET /api/surveys/:id/ar-detections
 * Returns all AR detection records for a survey, newest-first.
 */
export async function fetchARDetections(
  surveyId: string,
  token: string,
): Promise<ARDetectionListResponse> {
  const res = await fetchWithFallback(
    `/api/surveys/${surveyId}/ar-detections`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return handleResponse<ARDetectionListResponse>(res);
}

/**
 * POST /api/surveys/:id/photos/:photoId/infer
 * Runs Roboflow inference for a stored survey photo.
 */
export async function inferSurveyPhoto(
  surveyId: string,
  photoId: string,
  token: string,
  payload: PhotoInferenceRequest = {},
): Promise<PhotoInferenceResponse> {
  const res = await fetchWithFallback(
    `/api/surveys/${surveyId}/photos/${photoId}/infer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<PhotoInferenceResponse>(res);
}

/**
 * POST /api/users/refresh
 * Exchanges a valid refresh token for a new access token + rotated refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
  const res = await fetchWithFallback("/api/users/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return handleResponse<{ token: string; refreshToken: string }>(res);
}

/**
 * POST /api/users/logout
 * Revokes the refresh token server-side.
 */
export async function logout(refreshToken: string | null): Promise<void> {
  if (!refreshToken) return;
  try {
    await fetchWithFallback("/api/users/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Best-effort — local session cleared regardless
  }
}

/**
 * GET /api/handoff/:token
 * Retrieves prefill data for a handoff token.
 */
export interface HandoffPayload {
  project_id: string;
  project_name: string | null;
  site_name: string | null;
  site_address: string | null;
  inspector_name: string | null;
  category_id: string | null;
  category_name: string | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy: number | null;
  metadata: Record<string, unknown> | null;
  // F-06: Ownership routing — returned from backend when handoff JWT has claims
  solarpro_user_id: string | null;
  solarpro_project_id: string | null;
  solarpro_email: string | null;
}

export async function fetchHandoffToken(
  token: string,
): Promise<HandoffPayload> {
  const res = await fetchWithFallback(`/api/handoff/${encodeURIComponent(token)}`, {});
  return handleResponse<HandoffPayload>(res);
}

// ----------------------------------------------------------------
// Bug Reports
// ----------------------------------------------------------------

export interface BugReportResponse {
  id: string;
  screenshot_path: string;
  created_at: string;
}

export async function submitBugReport(input: {
  screenshotUri: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<BugReportResponse> {
  const form = new FormData();

  form.append("screenshot", {
    uri: input.screenshotUri,
    type: "image/jpeg",
    name: input.screenshotUri.split("/").pop() ?? "bug-report.jpg",
  } as unknown as Blob);

  if (input.title?.trim()) {
    form.append("title", input.title.trim());
  }

  if (input.description?.trim()) {
    form.append("description", input.description.trim());
  }

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    form.append("metadata", JSON.stringify(input.metadata));
  }

  const authHeaders = await getAuthHeaders();
  const res = await fetchWithFallback(
    "/api/bug-reports",
    {
      method: "POST",
      headers: authHeaders,
      body: form,
    },
    { timeoutMs: 120_000 },
  );

  return handleResponse<BugReportResponse>(res);
}

// ----------------------------------------------------------------
// SolarPro SSO
// ----------------------------------------------------------------

export interface SolarProSsoResponse {
  token: string;
  refreshToken: string;
  user: AuthUser & {
    solarpro_user_id: string | null;
    solarpro_project_id: string | null;
  };
}

/**
 * Exchange a SolarPro mobile-session JWT for a partner session.
 * Called after the app catches the sitesurvey://login?token=<jwt> deep link.
 *
 * POST /api/users/solarpro-sso
 * { token: <jwt signed with SOLARPRO_HANDOFF_SECRET> }
 */
export async function solarproSso(token: string): Promise<SolarProSsoResponse> {
  const res = await fetchWithFallback('/api/users/solarpro-sso', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return handleResponse<SolarProSsoResponse>(res);
}
