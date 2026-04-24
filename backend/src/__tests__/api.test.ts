import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac } from "crypto";
import app from "../index";
import { pool } from "../database";
import {
  inferRoboflowFromBuffer,
  inferRoboflowFromFile,
} from "../utils/yoloClient";

jest.mock("../utils/yoloClient", () => ({
  // yoloClient exports same function signatures as roboflowClient
  inferRoboflowFromBuffer: jest.fn(),
  inferRoboflowFromFile: jest.fn(),
  dataUrlToBuffer: jest.fn(() => Buffer.from("test-image")),
}));

// Clean up test surveys after each test
const createdIds: string[] = [];
let authHeader = "";
let testUserEmail = "";

const getAuth = (path: string) =>
  request(app).get(path).set("Authorization", authHeader);

beforeAll(async () => {
  testUserEmail = `apitest-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;

  const register = await request(app).post("/api/users/register").send({
    full_name: "API Test User",
    email: testUserEmail,
    password: "TestPass123!",
  });

  expect(register.status).toBe(201);
  expect(register.body.token).toBeDefined();

  authHeader = `Bearer ${register.body.token as string}`;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await pool.query("DELETE FROM surveys WHERE id = ANY($1)", [createdIds]);
  }
  if (testUserEmail) {
    await pool.query("DELETE FROM users WHERE email = $1", [testUserEmail]);
  }
  await pool.end();
});

// ----------------------------------------------------------------
// Health
// ----------------------------------------------------------------
describe("GET /api/health", () => {
  it("returns status ok with database connected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.database).toBe("connected");
    expect(res.body.timestamp).toBeDefined();
  });
});

// ----------------------------------------------------------------
// Users
// ----------------------------------------------------------------
describe("GET /api/users/me", () => {
  it("returns authenticated user profile", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(testUserEmail);
  });

  it("returns 401 without bearer token", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
  });
});

describe("Auth guard behavior", () => {
  it("blocks protected surveys route without token", async () => {
    const res = await request(app).get("/api/surveys");
    expect(res.status).toBe(401);
  });

  it("blocks protected categories route without token", async () => {
    const res = await request(app).get("/api/categories");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/users/signin rate limiting", () => {
  it("returns 429 after repeated invalid password attempts", async () => {
    const email = `ratelimit-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;

    const register = await request(app).post("/api/users/register").send({
      full_name: "Rate Limit User",
      email,
      password: "ValidPass123!",
    });

    expect(register.status).toBe(201);

    for (let i = 0; i < 4; i += 1) {
      const fail = await request(app)
        .post("/api/users/signin")
        .send({ email, password: "WrongPass999!" });

      expect(fail.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/users/signin")
      .send({ email, password: "WrongPass999!" });

    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain("Too many sign-in attempts");

    await pool.query("DELETE FROM users WHERE email = $1", [email]);
  });
});

describe("POST /api/users/signin admin login", () => {
  it("signs in using the seeded admin credentials", async () => {
    const res = await request(app)
      .post("/api/users/signin")
      .send({ identifier: "admin", password: "admin123!" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe("admin");
    expect(res.body.user.role).toBe("admin");
  });
});

describe("POST /api/users/forgot-password and /reset-password", () => {
  it("returns a reset token in non-production mode and accepts password reset", async () => {
    const email = `reset-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
    const initialPassword = "OriginalPass123!";
    const nextPassword = "NewSecurePass456!";

    const register = await request(app).post("/api/users/register").send({
      full_name: "Reset Flow User",
      email,
      password: initialPassword,
    });

    expect(register.status).toBe(201);

    const forgot = await request(app)
      .post("/api/users/forgot-password")
      .send({ email });

    expect(forgot.status).toBe(200);
    expect(typeof forgot.body.message).toBe("string");
    expect(typeof forgot.body.resetToken).toBe("string");

    const reset = await request(app).post("/api/users/reset-password").send({
      email,
      token: forgot.body.resetToken,
      new_password: nextPassword,
    });

    expect(reset.status).toBe(200);

    const signin = await request(app)
      .post("/api/users/signin")
      .send({ identifier: email, password: nextPassword });

    expect(signin.status).toBe(200);
    await pool.query("DELETE FROM users WHERE email = $1", [email]);
  });
});

describe("POST /api/users/oauth/:provider", () => {
  it("returns 501 for unconfigured supported provider", async () => {
    const res = await request(app).post("/api/users/oauth/google").send({});

    expect(res.status).toBe(501);
    expect(String(res.body.error || "")).toContain("not configured");
  });

  it("returns 400 for unsupported provider", async () => {
    const res = await request(app).post("/api/users/oauth/unknown").send({});

    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------
// Categories
// ----------------------------------------------------------------
describe("GET /api/categories", () => {
  it("returns seeded categories", async () => {
    const res = await getAuth("/api/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBeGreaterThanOrEqual(6);
    const names = res.body.categories.map((c: { name: string }) => c.name);
    expect(names).toContain("Electrical");
    expect(names).toContain("Safety");
  });
});

// ----------------------------------------------------------------
// Surveys CRUD
// ----------------------------------------------------------------
describe("POST /api/surveys", () => {
  it("creates a survey with checklist and returns 201", async () => {
    const payload = {
      project_name: "Test Project Alpha",
      inspector_name: "Jane Inspector",
      site_name: "Test Site 1",
      site_address: "123 Test Street",
      latitude: 51.5074,
      longitude: -0.1278,
      gps_accuracy: 5.0,
      notes: "Integration test survey",
      status: "draft",
      checklist: [
        { label: "Site Access", status: "pass", notes: "OK" },
        { label: "Power Supply", status: "fail", notes: "No power" },
        { label: "Safety Compliance", status: "pending", notes: "" },
      ],
    };

    const res = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send(payload)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.project_name).toBe("Test Project Alpha");
    expect(res.body.inspector_name).toBe("Jane Inspector");
    expect(res.body.latitude).toBeCloseTo(51.5074);
    expect(res.body.longitude).toBeCloseTo(-0.1278);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(res.body.checklist.length).toBe(3);
    expect(res.body.checklist[0].label).toBe("Site Access");
    expect(res.body.checklist[1].status).toBe("fail");

    createdIds.push(res.body.id);
  });

  it("creates survey when category_id is a slug-like value", async () => {
    const res = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Slug Category Survey",
        inspector_name: "Inspector",
        site_name: "Site",
        category_id: "roof_mount",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    createdIds.push(res.body.id);
  });

  it("creates survey when project_id/category_id are unknown UUIDs", async () => {
    const res = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Unknown FK Survey",
        inspector_name: "Inspector",
        site_name: "Site",
        project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        category_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    createdIds.push(res.body.id);
  });
});

describe("POST /api/surveys/validate/solar", () => {
  it("accepts a valid solar survey payload", async () => {
    const res = await request(app)
      .post("/api/surveys/validate/solar")
      .set("Authorization", authHeader)
      .send({
        customerName: "Jordan Solar",
        address: "100 Grid Avenue",
        gpsCoordinates: {
          latitude: 33.749,
          longitude: -84.388,
        },
        pitch: 27,
        azimuth: 185,
        roofType: "shingle",
        mainPanelAmps: 200,
        availableBreakerSlots: 4,
        photoUrls: ["https://example.com/photo-1.jpg"],
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.data.customerName).toBe("Jordan Solar");
    expect(res.body.data.roofType).toBe("shingle");
  });

  it("rejects an invalid solar survey payload with field issues", async () => {
    const res = await request(app)
      .post("/api/surveys/validate/solar")
      .set("Authorization", authHeader)
      .send({
        customerName: "",
        address: "100 Grid Avenue",
        gpsCoordinates: {
          latitude: 120,
          longitude: -84.388,
        },
        pitch: 95,
        azimuth: 420,
        roofType: "slate",
        mainPanelAmps: -1,
        availableBreakerSlots: 1.5,
        photoUrls: ["not-a-url"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid solar survey payload");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
    const paths = res.body.issues.map((issue: { path: string }) => issue.path);
    expect(paths).toContain("customerName");
    expect(paths).toContain("gpsCoordinates.latitude");
    expect(paths).toContain("photoUrls.0");
  });
});

describe("GET /api/surveys", () => {
  it("returns surveys array with total count", async () => {
    const res = await getAuth("/api/surveys");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.surveys)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("filters by status", async () => {
    const res = await getAuth("/api/surveys?status=draft");
    expect(res.status).toBe(200);
    res.body.surveys.forEach((s: { status: string }) => {
      expect(s.status).toBe("draft");
    });
  });
});

describe("GET /api/surveys/:id", () => {
  it("returns 422 for non-UUID id", async () => {
    const res = await getAuth("/api/surveys/not-a-uuid");
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_FAILED");
    expect(res.body.error?.field).toBe("id");
  });

  it("returns 404 for unknown id", async () => {
    const res = await getAuth(
      "/api/surveys/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
  });

  it("returns full survey object for known id", async () => {
    // Create one first
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Fetch Test",
        inspector_name: "Bob",
        site_name: "Site X",
      });
    createdIds.push(create.body.id);

    const res = await getAuth(`/api/surveys/${create.body.id as string}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(create.body.id);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(Array.isArray(res.body.photos)).toBe(true);
  });

  it("returns photo remote_url in survey detail payload", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Fetch Photo URL Test",
        inspector_name: "Bob",
        site_name: "Site X",
      });
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;

    await pool.query(
      `INSERT INTO survey_photos (survey_id, filename, label, file_path, mime_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [surveyId, "photo.jpg", "Roof", "/uploads/photo.jpg", "image/jpeg"],
    );

    const res = await getAuth(`/api/surveys/${surveyId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.photos.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.photos[0].remote_url).toBe("string");
  });
});

describe("PUT /api/surveys/:id", () => {
  it("updates a survey status", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Update Test",
        inspector_name: "Alice",
        site_name: "Site Y",
        status: "draft",
      });
    createdIds.push(create.body.id);

    const res = await request(app)
      .put(`/api/surveys/${create.body.id as string}`)
      .set("Authorization", authHeader)
      .send({ status: "submitted" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app)
      .put("/api/surveys/00000000-0000-0000-0000-000000000000")
      .set("Authorization", authHeader)
      .send({ status: "submitted" });
    expect(res.status).toBe(404);
  });
});

// ----------------------------------------------------------------
// Batch Sync
// ----------------------------------------------------------------
describe("POST /api/surveys/sync", () => {
  it("returns 422 when a survey id in batch is not UUID", async () => {
    const res = await request(app)
      .post("/api/surveys/sync")
      .set("Authorization", authHeader)
      .send({
        device_id: "test-device-001",
        surveys: [
          {
            action: "create",
            survey: {
              id: "legacy-local-id",
              project_name: "Offline Sync Project",
              inspector_name: "Sync Tester",
              site_name: "Offline Site",
            },
          },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_FAILED");
    expect(res.body.error?.field).toBe("id");
  });

  it("syncs survey when project_id/category_id are unknown UUIDs", async () => {
    const offlineId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    createdIds.push(offlineId);

    const res = await request(app)
      .post("/api/surveys/sync")
      .set("Authorization", authHeader)
      .send({
        device_id: "test-device-002",
        surveys: [
          {
            action: "create",
            survey: {
              id: offlineId,
              project_name: "Offline Unknown FK Project",
              inspector_name: "Sync Tester",
              site_name: "Offline Site",
              project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              category_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    expect(res.body.results[0].success).toBe(true);
  });

  it("returns 400 when surveys array is missing", async () => {
    const res = await request(app)
      .post("/api/surveys/sync")
      .set("Authorization", authHeader)
      .send({ device_id: "x" });
    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------
// Export endpoints
// ----------------------------------------------------------------
describe("GET /api/surveys/export/geojson", () => {
  it("returns valid GeoJSON FeatureCollection", async () => {
    const res = await getAuth("/api/surveys/export/geojson");
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("FeatureCollection");
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body.metadata.crs).toBe("EPSG:4326");
    // Every feature with a location has lon/lat in geometry
    res.body.features
      .filter((f: { geometry: unknown }) => f.geometry)
      .forEach(
        (f: {
          geometry: { type: string; coordinates: number[] };
          properties: {
            latitude: number;
            longitude: number;
            metadata: unknown;
          };
        }) => {
          expect(f.geometry.type).toBe("Point");
          expect(f.geometry.coordinates).toHaveLength(2);
          expect(typeof f.properties.latitude).toBe("number");
        },
      );
    // Features with solar metadata include the metadata property
    const solarFeatures = res.body.features.filter(
      (f: { properties: { metadata?: { type?: string } } }) =>
        f.properties.metadata?.type,
    );
    if (solarFeatures.length > 0) {
      const types = solarFeatures.map(
        (f: { properties: { metadata: { type: string } } }) =>
          f.properties.metadata.type,
      );
      types.forEach((t: string) => {
        expect(["ground_mount", "roof_mount", "solar_fencing"]).toContain(t);
      });
    }
  });
});

describe("GET /api/surveys/export/csv", () => {
  it("returns CSV with header row including metadata columns", async () => {
    const res = await getAuth("/api/surveys/export/csv");
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/text\/csv/);
    const lines = (res.text as string).split("\n").filter(Boolean);
    // Header row should exist with base columns
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("project_name");
    expect(lines[0]).toContain("latitude");
    expect(lines[0]).toContain("longitude");
    expect(lines[0]).toContain("status");
    // Solar metadata columns should be present
    expect(lines[0]).toContain("soil_type");
    expect(lines[0]).toContain("roof_material");
    expect(lines[0]).toContain("perimeter_length_ft");
    expect(lines[0]).toContain("metadata_json");
  });

  it("includes flattened metadata fields for Ground Mount surveys", async () => {
    // Create a ground-mount survey
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "CSV Meta Test",
        inspector_name: "Tester",
        site_name: "Field C",
        latitude: 51.0,
        longitude: -1.0,
        metadata: {
          type: "ground_mount",
          soil_type: "Rocky",
          slope_degrees: 4.2,
          trenching_path: "Clear path",
          vegetation_clearing: false,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth("/api/surveys/export/csv");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Rocky");
    expect(res.text).toContain("4.2");
    expect(res.text).toContain("ground_mount");
  });
});

// ----------------------------------------------------------------
// Engineering Assessment Report
// ----------------------------------------------------------------
describe("GET /api/surveys/:id/report", () => {
  it("returns 422 for non-UUID survey id", async () => {
    const res = await getAuth("/api/surveys/not-a-uuid/report");
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_FAILED");
    expect(res.body.error?.field).toBe("id");
  });

  it("returns 404 for unknown survey id", async () => {
    const res = await getAuth(
      "/api/surveys/00000000-0000-0000-0000-000000000099/report",
    );
    expect(res.status).toBe(404);
  });

  it("returns a valid EngineeringReport JSON with no flags for a clean survey", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Report Test Clean",
        inspector_name: "Jane",
        site_name: "Clean Site",
        status: "submitted",
        checklist: [
          { label: "Site Access", status: "pass", notes: "" },
          { label: "Safety Check", status: "pass", notes: "" },
        ],
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.survey_id).toBe(create.body.id);
    expect(res.body.overall_risk).toBe("None");
    expect(Array.isArray(res.body.flags)).toBe(true);
    expect(res.body.flags).toHaveLength(0);
    expect(res.body.checklist_summary.pass).toBe(2);
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(res.body.generated_at).toBeDefined();
  });

  it("flags High priority for old Roof Mount (age > 15)", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Old Roof Report Test",
        inspector_name: "Alice",
        site_name: "Old House",
        category_name: "Roof Mount",
        status: "submitted",
        metadata: {
          type: "roof_mount",
          roof_material: "Asphalt Shingle",
          rafter_size: "2x6",
          rafter_spacing: "16in",
          roof_age_years: 20,
          azimuth: 180,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.overall_risk).toBe("High");
    const flag = res.body.flags.find(
      (f: { field: string }) => f.field === "roof_age_years",
    );
    expect(flag).toBeDefined();
    expect(flag.priority).toBe("High");
  });

  it("flags High priority for Membrane roof material", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Membrane Roof Test",
        inspector_name: "Bob",
        site_name: "Commercial Unit 5",
        category_name: "Roof Mount",
        status: "submitted",
        metadata: {
          type: "roof_mount",
          roof_material: "Membrane",
          rafter_size: "2x8",
          rafter_spacing: "24in",
          roof_age_years: 5,
          azimuth: 200,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.overall_risk).toBe("High");
    const flag = res.body.flags.find(
      (f: { field: string }) => f.field === "roof_material",
    );
    expect(flag).toBeDefined();
    expect(flag.priority).toBe("High");
  });

  it("flags High priority for Rocky soil (Ground Mount)", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Rocky Ground Test",
        inspector_name: "Carlos",
        site_name: "Hill Farm",
        category_name: "Ground Mount",
        status: "submitted",
        metadata: {
          type: "ground_mount",
          soil_type: "Rocky",
          slope_degrees: 5.0,
          trenching_path: "Avoid east berm",
          vegetation_clearing: true,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.overall_risk).toBe("High");
    const flag = res.body.flags.find(
      (f: { field: string }) => f.field === "soil_type",
    );
    expect(flag).toBeDefined();
    expect(flag.priority).toBe("High");
  });

  it("flags High priority when lower_shade_risk is true (Solar Fencing)", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Fencing Shade Test",
        inspector_name: "Diana",
        site_name: "Agri Plot 3",
        category_name: "Solar Fencing",
        status: "submitted",
        metadata: {
          type: "solar_fencing",
          perimeter_length_ft: 800,
          lower_shade_risk: true,
          foundation_type: "Driven Piles",
          bifacial_surface: "Grass",
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.overall_risk).toBe("High");
    const flag = res.body.flags.find(
      (f: { field: string }) => f.field === "lower_shade_risk",
    );
    expect(flag).toBeDefined();
    expect(flag.priority).toBe("High");
  });

  it("flags High priority when Main Service Panel checklist item fails", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Electrical Panel Test",
        inspector_name: "Eve",
        site_name: "Residential Site 7",
        category_name: "Electrical",
        status: "submitted",
        checklist: [
          { label: "Main Service Panel", status: "fail", notes: "Overloaded" },
          { label: "Earthing", status: "pass", notes: "" },
        ],
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.overall_risk).toBe("High");
    const flag = res.body.flags.find(
      (f: { field: string }) => f.field === "checklist:Main Service Panel",
    );
    expect(flag).toBeDefined();
    expect(flag.priority).toBe("High");
    expect(res.body.checklist_summary.fail).toBe(1);
    expect(res.body.checklist_summary.pass).toBe(1);
  });

  it("returns Markdown download when ?format=markdown", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Markdown Report Test",
        inspector_name: "Frank",
        site_name: "Site MD",
        category_name: "Roof Mount",
        status: "submitted",
        metadata: {
          type: "roof_mount",
          roof_material: "Membrane",
          rafter_size: "2x4",
          rafter_spacing: "16in",
          roof_age_years: 18,
          azimuth: 175,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report?format=markdown`,
    );

    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/text\/markdown/);
    expect(res.header["content-disposition"]).toMatch(/attachment/);
    expect(res.header["content-disposition"]).toMatch(/\.md/);
    // Markdown should contain core headings
    expect(res.text).toContain("# Engineering Assessment Report");
    expect(res.text).toContain("## Overall Risk");
    expect(res.text).toContain("High");
    expect(res.text).toContain("Membrane");
    expect(res.text).toContain("Markdown Report Test");
  });

  it("accumulates multiple flags on a single survey (old Membrane roof)", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Double Flag Test",
        inspector_name: "Grace",
        site_name: "Warehouse Roof",
        category_name: "Roof Mount",
        status: "submitted",
        metadata: {
          type: "roof_mount",
          roof_material: "Membrane",
          rafter_size: "2x6",
          rafter_spacing: "24in",
          roof_age_years: 22,
          azimuth: 190,
        },
      });
    createdIds.push(create.body.id);

    const res = await getAuth(
      `/api/surveys/${create.body.id as string}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.flags.length).toBeGreaterThanOrEqual(2);
    const fields = res.body.flags.map((f: { field: string }) => f.field);
    expect(fields).toContain("roof_age_years");
    expect(fields).toContain("roof_material");
  });
});

describe("POST /api/surveys/:id/photos/:photoId/infer", () => {
  it("returns 422 when photoId is not UUID", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Infer Invalid Photo ID",
        inspector_name: "Ivy",
        site_name: "Inference Site",
      });
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;

    const res = await request(app)
      .post(`/api/surveys/${surveyId}/photos/not-a-uuid/infer`)
      .set("Authorization", authHeader)
      .send({ model_id: "electrical-inspection/1" });

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_FAILED");
    expect(res.body.error?.field).toBe("photoId");
  });

  it("returns vision inference for a survey photo using data_url", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Infer Route Test",
        inspector_name: "Ivy",
        site_name: "Inference Site",
      });
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;
    const { rows } = await pool.query(
      `INSERT INTO survey_photos (survey_id, filename, label, data_url, mime_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        surveyId,
        "panel.jpg",
        "Main Service Panel",
        "data:image/jpeg;base64,aGVsbG8=",
        "image/jpeg",
      ],
    );
    const photoId = rows[0].id as string;

    (inferRoboflowFromBuffer as jest.Mock).mockResolvedValueOnce({
      detections: [{ type: "main_panel", classId: 6, confidence: 0.97, bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, bboxPixels: { x: 64, y: 64, width: 128, height: 128 }, imageWidth: 640, imageHeight: 640 }],
      detectionCount: 1,
      inferenceMs: 42,
      modelPath: "models/solarvision.pt",
    });

    const res = await request(app)
      .post(`/api/surveys/${surveyId}/photos/${photoId}/infer`)
      .set("Authorization", authHeader)
      .send({
        model_id: "electrical-inspection/1",
        confidence: 40,
        overlap: 30,
      });

    expect(res.status).toBe(200);
    expect(res.body.survey_id).toBe(surveyId);
    expect(res.body.photo_id).toBe(photoId);
    expect(res.body.model_id).toBe("electrical-inspection/1");
    expect(res.body.inference.detections[0].type).toBe("main_panel");
    expect(inferRoboflowFromBuffer).toHaveBeenCalledTimes(1);
    expect(inferRoboflowFromFile).not.toHaveBeenCalled();

    const { rows: logRows } = await pool.query(
      `SELECT survey_id, photo_id, model_id, prediction_count
         FROM photo_inference_logs
        WHERE survey_id = $1 AND photo_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [surveyId, photoId],
    );

    expect(logRows.length).toBe(1);
    expect(logRows[0].survey_id).toBe(surveyId);
    expect(logRows[0].photo_id).toBe(photoId);
    expect(logRows[0].model_id).toBe("electrical-inspection/1");
    expect(Number(logRows[0].prediction_count)).toBe(1);
  });

  it("returns 502 when vision inference fails", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Infer Error Test",
        inspector_name: "Noah",
        site_name: "Inference Error Site",
      });
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;
    const { rows } = await pool.query(
      `INSERT INTO survey_photos (survey_id, filename, label, data_url, mime_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        surveyId,
        "meter.jpg",
        "Meter",
        "data:image/jpeg;base64,aGVsbG8=",
        "image/jpeg",
      ],
    );
    const photoId = rows[0].id as string;

    (inferRoboflowFromBuffer as jest.Mock).mockRejectedValueOnce(
      new Error("Vision service unavailable"),
    );

    const res = await request(app)
      .post(`/api/surveys/${surveyId}/photos/${photoId}/infer`)
      .set("Authorization", authHeader)
      .send({ model_id: "electrical-inspection/1" });

    expect(res.status).toBe(502);
    expect(String(res.body.error || "")).toContain("Vision service unavailable");
  });
});

describe("GET /api/surveys/inference-logs/recent", () => {
  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/surveys/inference-logs/recent")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin access required");
  });

  it("returns recent inference telemetry for admin users", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Telemetry Query Test",
        inspector_name: "Uma",
        site_name: "Telemetry Site",
      });
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;
    const { rows } = await pool.query(
      `INSERT INTO survey_photos (survey_id, filename, label, data_url, mime_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        surveyId,
        "disconnect.jpg",
        "Disconnect",
        "data:image/jpeg;base64,aGVsbG8=",
        "image/jpeg",
      ],
    );
    const photoId = rows[0].id as string;

    (inferRoboflowFromBuffer as jest.Mock).mockResolvedValueOnce({
      predictions: [{ class: "disconnect", confidence: 0.91 }],
    });

    const inferRes = await request(app)
      .post(`/api/surveys/${surveyId}/photos/${photoId}/infer`)
      .set("Authorization", authHeader)
      .send({ model_id: "electrical-inspection/1" });

    expect(inferRes.status).toBe(200);

    const adminSignin = await request(app)
      .post("/api/users/signin")
      .send({ identifier: "admin", password: "admin123!" });

    expect(adminSignin.status).toBe(200);

    const telemetryRes = await request(app)
      .get(`/api/surveys/inference-logs/recent?survey_id=${surveyId}`)
      .set("Authorization", `Bearer ${adminSignin.body.token as string}`);

    expect(telemetryRes.status).toBe(200);
    expect(telemetryRes.body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(telemetryRes.body.logs)).toBe(true);
    expect(telemetryRes.body.logs[0].survey_id).toBe(surveyId);
    expect(telemetryRes.body.logs[0].photo_id).toBe(photoId);
    expect(telemetryRes.body.logs[0].model_id).toBe("electrical-inspection/1");
    expect(telemetryRes.body.logs[0].prediction_count).toBe(1);
  });
});

// ----------------------------------------------------------------
// Handoff Prefill Token
// ----------------------------------------------------------------
describe("GET /api/handoff/:token", () => {
  it("returns prefill payload for valid token", async () => {
    const token = jwt.sign(
      {
        jti: `handoff-${Date.now()}`,
        project_id: "33333333-3333-4333-8333-333333333333",
        project_name: "SolarPro Project Alpha",
        site_name: "123 Grid Street",
        site_address: "123 Grid Street, Austin, TX",
        inspector_name: "Field Inspector",
        category_id: "roof_mount",
        notes: "Prefilled from SolarPro",
      },
      process.env.SOLARPRO_HANDOFF_SECRET as string,
      { expiresIn: "10m" },
    );

    const res = await request(app).get(`/api/handoff/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.project_name).toBe("SolarPro Project Alpha");
    expect(res.body.site_name).toBe("123 Grid Street");
  });

  it("returns 401 for invalid token", async () => {
    const res = await request(app).get("/api/handoff/not-a-real-token");
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("INVALID_HANDOFF_TOKEN");
  });

  it("returns 422 when token misses jti", async () => {
    const token = jwt.sign(
      {
        project_id: "33333333-3333-4333-8333-333333333333",
      },
      process.env.SOLARPRO_HANDOFF_SECRET as string,
      { expiresIn: "10m" },
    );

    const res = await request(app).get(`/api/handoff/${token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.field).toBe("jti");
  });

  it("returns 409 when token is replayed", async () => {
    const token = jwt.sign(
      {
        jti: `handoff-replay-${Date.now()}`,
        project_id: "33333333-3333-4333-8333-333333333333",
      },
      process.env.SOLARPRO_HANDOFF_SECRET as string,
      { expiresIn: "10m" },
    );

    const first = await request(app).get(`/api/handoff/${token}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/api/handoff/${token}`);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("HANDOFF_TOKEN_REPLAYED");
  });
});

describe("POST /api/surveys/:id/complete", () => {
  it("marks survey submitted and returns stable event id on repeated calls", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Completion Test",
        inspector_name: "Completer",
        site_name: "Complete Site",
      });

    expect(create.status).toBe(201);
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;

    const first = await request(app)
      .post(`/api/surveys/${surveyId}/complete`)
      .set("Authorization", authHeader)
      .send({});

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("submitted");
    expect(first.body.survey_id).toBe(surveyId);
    expect(typeof first.body.event_id).toBe("string");

    const second = await request(app)
      .post(`/api/surveys/${surveyId}/complete`)
      .set("Authorization", authHeader)
      .send({});

    expect(second.status).toBe(200);
    expect(second.body.event_id).toBe(first.body.event_id);
  });

  it("returns 422 for invalid UUID id", async () => {
    const res = await request(app)
      .post("/api/surveys/not-a-uuid/complete")
      .set("Authorization", authHeader)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_FAILED");
    expect(res.body.error?.field).toBe("id");
  });
});

describe("GET /api/surveys/admin/webhook-deliveries", () => {
  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/surveys/admin/webhook-deliveries")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
  });

  it("returns deliveries for admin users", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Webhook List Test",
        inspector_name: "Auditor",
        site_name: "Webhook Site",
      });

    expect(create.status).toBe(201);
    createdIds.push(create.body.id);

    const surveyId = create.body.id as string;

    const complete = await request(app)
      .post(`/api/surveys/${surveyId}/complete`)
      .set("Authorization", authHeader)
      .send({});

    expect(complete.status).toBe(200);

    const adminSignin = await request(app)
      .post("/api/users/signin")
      .send({ identifier: "admin", password: "admin123!" });

    expect(adminSignin.status).toBe(200);

    const res = await request(app)
      .get(`/api/surveys/admin/webhook-deliveries?survey_id=${surveyId}`)
      .set("Authorization", `Bearer ${adminSignin.body.token as string}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.deliveries[0].survey_id).toBe(surveyId);
    expect(res.body.deliveries[0].event_type).toBe("survey.completed");
  });
});

describe("GET /api/surveys/admin/surveys", () => {
  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/surveys/admin/surveys")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
  });

  it("returns survey info list for admin users", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Admin Survey View",
        inspector_name: "Admin Inspector",
        site_name: "Admin Site",
      });

    expect(create.status).toBe(201);
    createdIds.push(create.body.id);

    const adminSignin = await request(app)
      .post("/api/users/signin")
      .send({ identifier: "admin", password: "admin123!" });

    expect(adminSignin.status).toBe(200);

    const res = await request(app)
      .get("/api/surveys/admin/surveys?limit=10")
      .set("Authorization", `Bearer ${adminSignin.body.token as string}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.surveys)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.surveys.some((s: { id: string }) => s.id === create.body.id)).toBe(true);
  });
});

// ----------------------------------------------------------------
// OpenAPI
// ----------------------------------------------------------------
describe("GET /api/openapi.json", () => {
  it("returns OpenAPI document", async () => {
    const res = await request(app).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.paths).toBeDefined();
    expect(res.body.paths["/surveys"]).toBeDefined();
  });
});

// ----------------------------------------------------------------
// Surveys soft-delete
// ----------------------------------------------------------------
describe("DELETE /api/surveys/:id", () => {
  it("soft-deletes survey and hides it from list and detail endpoints", async () => {
    const create = await request(app)
      .post("/api/surveys")
      .set("Authorization", authHeader)
      .send({
        project_name: "Soft Delete Test",
        inspector_name: "Del Tester",
        site_name: "Delete Site",
      });

    expect(create.status).toBe(201);
    const surveyId = create.body.id as string;

    const del = await request(app)
      .delete(`/api/surveys/${surveyId}`)
      .set("Authorization", authHeader);

    expect(del.status).toBe(204);

    const byId = await getAuth(`/api/surveys/${surveyId}`);
    expect(byId.status).toBe(404);

    const list = await getAuth("/api/surveys");
    expect(list.status).toBe(200);
    const ids = list.body.surveys.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(surveyId);
  });
});

describe("GET /api/metrics", () => {
  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/metrics")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
  });

  it("returns metrics snapshot for admin users", async () => {
    const adminSignin = await request(app)
      .post("/api/users/signin")
      .send({ identifier: "admin", password: "admin123!" });

    expect(adminSignin.status).toBe(200);

    const res = await request(app)
      .get("/api/metrics")
      .set("Authorization", `Bearer ${adminSignin.body.token as string}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.uptime_seconds).toBe("number");
    expect(res.body.counters).toBeDefined();
    expect(typeof res.body.counters.api_requests_total).toBe("number");
    expect(res.body.timings?.http_request_duration_ms).toBeDefined();
  });
});

// ----------------------------------------------------------------
// Webhook Inbound Receiver
// ----------------------------------------------------------------
describe("POST /api/webhooks/survey-complete", () => {
  const originalSecret = process.env.SURVEY_WEBHOOK_SECRET;
  const originalPreIngest = process.env.WEBHOOK_PRE_INGEST_ACCEPT_202;

  const payload = {
    event: "survey.completed",
    event_id: "evt-test-1001",
    occurred_at: "2026-04-23T18:25:43.000Z",
    survey_id: "4f2a587d-4d18-4f8c-8f88-9ed6d26ff7c0",
    status: "submitted",
    completed_at: "2026-04-23T18:25:41.382Z",
  };

  function signatureFor(timestamp: string, rawBody: string, secret: string): string {
    const digest = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    return `sha256=${digest}`;
  }

  beforeEach(() => {
    process.env.SURVEY_WEBHOOK_SECRET = "whsec_test_suite_secret";
    process.env.WEBHOOK_PRE_INGEST_ACCEPT_202 = "true";
  });

  afterEach(async () => {
    process.env.SURVEY_WEBHOOK_SECRET = originalSecret;
    process.env.WEBHOOK_PRE_INGEST_ACCEPT_202 = originalPreIngest;
    try {
      await pool.query("DELETE FROM webhook_inbound_events WHERE event_id LIKE 'evt-test-%'");
    } catch {
      // table may not exist when a test exits before first valid insert
    }
  });

  it("returns 401 on invalid signature", async () => {
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();

    const res = await request(app)
      .post("/api/webhooks/survey-complete")
      .set("X-Survey-Timestamp", timestamp)
      .set("X-Survey-Event-Id", payload.event_id)
      .set("X-Survey-Signature", "sha256=deadbeef")
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("SIGNATURE_MISMATCH");
  });

  it("returns 202 for valid signature in pre-ingest mode", async () => {
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature = signatureFor(timestamp, rawBody, process.env.SURVEY_WEBHOOK_SECRET as string);

    const res = await request(app)
      .post("/api/webhooks/survey-complete")
      .set("X-Survey-Timestamp", timestamp)
      .set("X-Survey-Event-Id", payload.event_id)
      .set("X-Survey-Signature", signature)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.code).toBe("ACCEPTED_PRE_INGEST");
  });
});
