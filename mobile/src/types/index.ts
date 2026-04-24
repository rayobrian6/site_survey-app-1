// ============================================================
// Shared TypeScript types for the mobile app
// ============================================================

export type SurveyStatus = "draft" | "submitted" | "synced";
export type SyncStatus = "pending" | "syncing" | "synced" | "error";
export type ChecklistStatus = "pass" | "fail" | "n/a" | "pending";

// ------------------------------------------------------------------
// Solar installation metadata types
// Stored as JSONB on the server and as JSON text in local SQLite.
// The `type` discriminator matches the category_id slug.
// ------------------------------------------------------------------

export interface GroundMountMetadata {
  type: "ground_mount";
  soil_type: "Rocky" | "Sandy" | "Clay" | "Organic/Loam" | null;
  slope_degrees: number | null;
  trenching_path: string;
  vegetation_clearing: boolean;
}

export interface RoofMountMetadata {
  type: "roof_mount";
  roof_material: "Asphalt Shingle" | "Metal" | "Tile" | "Membrane" | null;
  rafter_size: "2x4" | "2x6" | "2x8" | null;
  rafter_spacing: "16in" | "24in" | null;
  roof_age_years: number | null;
  azimuth: number | null;
}

export interface SolarFencingMetadata {
  type: "solar_fencing";
  perimeter_length_ft: number | null;
  lower_shade_risk: boolean;
  foundation_type: "Driven Piles" | "Concrete Footer" | null;
  bifacial_surface: "Concrete" | "Gravel" | "Grass" | "Dirt" | null;
}

export interface CommercialThreePhaseMetadata {
  type: "commercial_3phase";
  // 1) Project Site Information
  customer_name: string;
  customer_address: string;
  city: string;
  state: string;
  zip: string;
  parcel_number: string;
  utility_having_jurisdiction: string;
  municipality_having_jurisdiction: string;
  nec_code_year: number | null;
  // 2) Environmental & Structural Constraints
  snow_load_lbs_sqft: number | null;
  seismic_rating: "A" | "B" | "C" | "D" | "E" | "F" | null;
  building_height_ft: number | null;
  max_wind_speed_mph: number | null;
  wind_exposure: "B" | "C" | "D" | null;
  // 3) PV System Information
  desired_pv_system_size_kw_dc: number | null;
  module_make_model: string;
  number_of_modules: number | null;
  module_tilt_angle_deg: number | null;
  module_azimuth_deg: number | null;
}

export type SurveyMetadata =
  | GroundMountMetadata
  | RoofMountMetadata
  | SolarFencingMetadata
  | CommercialThreePhaseMetadata;

// ------------------------------------------------------------------
// Core domain models
// ------------------------------------------------------------------

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export interface ChecklistItem {
  id: string;
  survey_id: string;
  label: string;
  status: ChecklistStatus;
  notes: string;
  sort_order: number;
  created_at: string;
}

export interface SurveyPhoto {
  id: string;
  survey_id: string;
  /** Absolute local path inside the app's document directory */
  file_path: string;
  label: string;
  mime_type: string;
  captured_at: string;
  created_at: string;
}

export interface Survey {
  id: string;
  project_name: string;
  project_id: string | null;
  category_id: string | null;
  category_name: string | null;
  inspector_name: string;
  site_name: string;
  site_address: string;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy: number | null;
  survey_date: string;
  notes: string;
  /** Server-facing status */
  status: SurveyStatus;
  /** Offline-sync tracking status (local only) */
  sync_status: SyncStatus;
  sync_error: string | null;
  device_id: string | null;
  /** Category-specific fields — Ground Mount / Roof Mount / Solar Fencing */
  metadata: SurveyMetadata | null;
  created_at: string;
  updated_at: string;
  /** Hydrated relations — populated when loading a full survey */
  checklist: ChecklistItem[];
  photos: SurveyPhoto[];
  // F-06: Ownership routing — from SolarPro handoff JWT claims
  solarpro_user_id?: string | null;
  solarpro_project_id?: string | null;
  solarpro_email?: string | null;
  solarpro_org_id?: string | null;
}

export type SurveyFormData = Omit<
  Survey,
  | "id"
  | "sync_status"
  | "sync_error"
  | "created_at"
  | "updated_at"
  | "checklist"
  | "photos"
> & {
  checklist: Omit<ChecklistItem, "id" | "survey_id" | "created_at">[];
  photos: Omit<SurveyPhoto, "id" | "survey_id" | "created_at">[];
};

// ------------------------------------------------------------------
// API response shapes
// ------------------------------------------------------------------

export interface ApiSurveyListResponse {
  surveys: Survey[];
  total: number;
}

export interface ApiSyncResponse {
  synced: number;
  results: Array<{
    id: string;
    action: string;
    success: boolean;
    error?: string;
  }>;
}

export interface ApiPhotoUploadResponse {
  uploaded: number;
  photos: unknown[];
}

// ------------------------------------------------------------------
// Default checklist items for new surveys
// ------------------------------------------------------------------
export const DEFAULT_CHECKLIST: Omit<
  ChecklistItem,
  "id" | "survey_id" | "created_at"
>[] = [
  { label: "Site Access", status: "pending", notes: "", sort_order: 0 },
  { label: "Overhead Line", status: "pending", notes: "", sort_order: 1 },
  { label: "Meter", status: "pending", notes: "", sort_order: 2 },
  {
    label: "Network Connectivity",
    status: "pending",
    notes: "",
    sort_order: 3,
  },
  { label: "Safety Compliance", status: "pending", notes: "", sort_order: 4 },
  { label: "Equipment Condition", status: "pending", notes: "", sort_order: 5 },
  {
    label: "Documentation Review",
    status: "pending",
    notes: "",
    sort_order: 6,
  },
];

export const SURVEY_CATEGORIES = [
  { id: "", name: "Select category…" },
  { id: "electrical", name: "Electrical" },
  { id: "structural", name: "Structural" },
  { id: "network", name: "Network/Comms" },
  { id: "environmental", name: "Environmental" },
  { id: "safety", name: "Safety" },
  { id: "general", name: "General Inspection" },
  // Solar installation categories — trigger category-specific metadata sections
  { id: "ground_mount", name: "Ground Mount" },
  { id: "roof_mount", name: "Roof Mount" },
  { id: "solar_fencing", name: "Solar Fencing" },
  { id: "commercial_3phase", name: "Commercial 3-Phase Solar" },
];

// ------------------------------------------------------------------
// AR Detection types
// Used by the mobile AR inspection workflow.
// Each detected object carries a ByteTracker-assigned `track_id`
// which remains stable across camera frames, letting the AR engine
// re-anchor the label to the same physical object (MSP, meter, etc.)
// when the camera pans away and returns.
// The optional `depth_m` is supplied by the Depth Estimation model
// so the label is pinned to the actual surface of the panel, not
// floating in mid-air.
// ------------------------------------------------------------------

export interface ARElectricalDetection {
  /** Object class label, e.g. "panel" | "meter" | "breaker" | "disconnect" */
  class: string;
  /** Model confidence score in [0, 1] */
  confidence: number;
  /** Stable ByteTracker ID assigned across frames */
  track_id: number;
  /** Depth from camera to object surface in metres (Depth Estimation model) */
  depth_m?: number;
  /** Human-readable AR overlay label, e.g. "MSP — 200A" */
  ar_label?: string;
}

export interface ARExteriorDetection {
  /** Object class label, e.g. "roof" | "conduit" | "weatherhead" | "disconnect" */
  class: string;
  /** Model confidence score in [0, 1] */
  confidence: number;
  /** Stable ByteTracker ID assigned across frames */
  track_id: number;
  depth_m?: number;
  ar_label?: string;
}

export interface ARMeasurements {
  meter_to_panel_distance?: string;
  [key: string]: string | undefined;
}

/** Depth-anchored spatial readings from the Depth Estimation model */
export interface ARDistances {
  [key: string]: string | undefined;
}

/** Payload sent to POST /api/surveys/:id/ar-detection */
export interface ARDetectionPayload {
  /** Matches the survey's project_id on the server */
  project_id: string;
  electrical: ARElectricalDetection[];
  /** Structural / exterior detections (roof, conduit, weatherhead, etc.) */
  exterior?: ARExteriorDetection[];
  /** Depth-anchored spatial distances from the AR Depth Estimation model */
  distances?: ARDistances;
  /**
   * Flat list of all active ByteTracker IDs in the session.
   * If omitted the backend derives it from the union of electrical + exterior track_ids.
   */
  track_ids?: number[];
  measurements?: ARMeasurements;
  /** ISO-8601 client-side capture timestamp. Backend stores it as detected_at. */
  timestamp?: string;
  roof_type?: string;
}

/** Response from POST /api/surveys/:id/ar-detection */
export interface ARDetectionResponse {
  status: string;
  message: string;
}

/** Response from GET /api/surveys/:id/ar-detections */
export interface ARDetectionListResponse {
  detections: ARDetectionResponse[];
  total: number;
}

// ------------------------------------------------------------------
// Survey Photo Inference (Roboflow)
// ------------------------------------------------------------------

export interface PhotoInferenceRequest {
  model_id?: string;
  confidence?: number;
  overlap?: number;
  elec_classes?: string[];
  material_classes?: string[];
}

export interface PhotoInferenceResponse {
  survey_id: string;
  photo_id: string;
  model_id: string | null;
  inference: unknown;
}
