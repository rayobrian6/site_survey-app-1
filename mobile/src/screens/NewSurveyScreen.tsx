import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import { useAuth } from "../context/AuthContext";
import { useAppBootstrap } from "../context/AppBootstrapContext";
import { createSurvey } from "../database/surveyDb";
import type { SurveyFormData, SurveyMetadata } from "../types";
import { DEFAULT_CHECKLIST, SURVEY_CATEGORIES } from "../types";
import ChecklistEditor, { type ChecklistItemDraft } from "../components/ChecklistEditor";
import GPSCapture from "../components/GPSCapture";
import PhotoCapture, { type PhotoDraft } from "../components/PhotoCapture";
import SolarMetadataForm from "../components/SolarMetadataForm";
import { useLocation } from "../hooks/useLocation";
import { solarProTheme } from "../theme/solarProTheme";
import { fetchHandoffToken } from "../api/client";

const { colors } = solarProTheme;
const AUTO_SAVE_INTERVAL_MS = 300_000;
const DRAFTS_DIR = `${FileSystem.documentDirectory}survey-drafts/`;

interface NewSurveyDraft {
  saved_at: string;
  project_name: string;
  inspector_name: string;
  site_name: string;
  site_address: string;
  category_id: string | null;
  notes: string;
  coordinates: { latitude: number; longitude: number; accuracy?: number } | null;
  metadata: SurveyMetadata | null;
  checklist: ChecklistItemDraft[];
  photos: PhotoDraft[];
  user_id: string | null;
}

export default function NewSurveyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ t?: string; token?: string }>();
  const handoffToken =
    typeof params.token === "string"
      ? params.token
      : typeof params.t === "string"
        ? params.t
        : null;
  const { user } = useAuth();
  const { deviceId } = useAppBootstrap();
  const location = useLocation();

  const [projectName, setProjectName] = useState("Mobile Site Survey");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [inspectorName, setInspectorName] = useState(user?.fullName ?? "");
  const [siteName, setSiteName] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>("roof_mount");
  const [metadata, setMetadata] = useState<SurveyMetadata | null>(null);
  const [notes, setNotes] = useState("");
  const [handoffLinked, setHandoffLinked] = useState(false);
  // F-06 ownership claims captured from handoff token
  const [solarproUserId, setSolarproUserId] = useState<string | null>(null);
  const [solarproProjectId, setSolarproProjectId] = useState<string | null>(null);
  const [solarproEmail, setSolarproEmail] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItemDraft[]>(
    DEFAULT_CHECKLIST.map((c) => ({
      label: c.label,
      status: c.status,
      notes: c.notes,
      photos: [],
    })),
  );
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [draftFileUri, setDraftFileUri] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  const stepLabels = ["Site Info", "Checklist", "Photos", "Review"] as const;

  const canProceedStep1 =
    projectName.trim().length > 0 &&
    inspectorName.trim().length > 0 &&
    siteName.trim().length > 0;

  const requiredPhotoSlots = 2;
  const hasMinimumPhotos = photos.length >= requiredPhotoSlots;

  const selectedCategoryName = useMemo(() => {
    const found = SURVEY_CATEGORIES.find((c) => c.id === (categoryId ?? ""));
    return found?.name ?? null;
  }, [categoryId]);

  const solarCategoryIds = new Set(["ground_mount", "roof_mount", "solar_fencing"]);

  const buildDraftPayload = useCallback((): NewSurveyDraft => ({
    saved_at: new Date().toISOString(),
    project_name: projectName,
    inspector_name: inspectorName,
    site_name: siteName,
    site_address: siteAddress,
    category_id: categoryId,
    notes,
    coordinates: location.coordinates,
    metadata,
    checklist,
    photos,
    user_id: user?.id ?? null,
  }), [
    projectName,
    inspectorName,
    siteName,
    siteAddress,
    categoryId,
    notes,
    location.coordinates,
    metadata,
    checklist,
    photos,
    user?.id,
  ]);

  const saveDraftToFile = useCallback(async () => {
    if (!draftFileUri) return;
    await FileSystem.writeAsStringAsync(
      draftFileUri,
      JSON.stringify(buildDraftPayload(), null, 2),
      { encoding: FileSystem.EncodingType.UTF8 },
    );
  }, [buildDraftPayload, draftFileUri]);

  // Create a single draft file when the screen opens
  useEffect(() => {
    let mounted = true;

    async function initDraftFile() {
      try {
        await FileSystem.makeDirectoryAsync(DRAFTS_DIR, { intermediates: true });
        const uri = `${DRAFTS_DIR}draft-${Date.now()}.json`;
        await FileSystem.writeAsStringAsync(
          uri,
          JSON.stringify(buildDraftPayload(), null, 2),
          { encoding: FileSystem.EncodingType.UTF8 },
        );
        if (mounted) setDraftFileUri(uri);
      } catch (err) {
        console.error("Draft init error:", err);
      }
    }

    initDraftFile();
    return () => {
      mounted = false;
    };
    // intentionally run once for file creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft every 300 seconds and once on unmount
  useEffect(() => {
    if (!draftFileUri) return;

    const timer = setInterval(() => {
      saveDraftToFile().catch((err) =>
        console.error("Draft autosave error:", err),
      );
    }, AUTO_SAVE_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      saveDraftToFile().catch((err) =>
        console.error("Draft final save error:", err),
      );
    };
  }, [draftFileUri, saveDraftToFile]);

  useEffect(() => {
    if (categoryId && !solarCategoryIds.has(categoryId)) {
      setMetadata(null);
    }
  }, [categoryId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateFromHandoff() {
      if (!handoffToken) return;
      try {
        const handoff = await fetchHandoffToken(handoffToken);
        if (cancelled) return;

        setProjectId(handoff.project_id);
        if (handoff.project_name) setProjectName(handoff.project_name);
        if (handoff.inspector_name) setInspectorName(handoff.inspector_name);
        if (handoff.site_name) setSiteName(handoff.site_name);
        if (handoff.site_address) setSiteAddress(handoff.site_address);
        if (handoff.category_id) setCategoryId(handoff.category_id);
        if (handoff.notes) setNotes(handoff.notes);
        if (handoff.metadata) {
          setMetadata(handoff.metadata as unknown as SurveyMetadata);
        }
        // F-06: capture ownership claims from handoff
        if (handoff.solarpro_user_id) setSolarproUserId(handoff.solarpro_user_id);
        if (handoff.solarpro_project_id) setSolarproProjectId(handoff.solarpro_project_id);
        if (handoff.solarpro_email) setSolarproEmail(handoff.solarpro_email);
        setHandoffLinked(true);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load handoff token";
        Alert.alert("Handoff Error", message);
      }
    }

    hydrateFromHandoff();
    return () => {
      cancelled = true;
    };
  }, [handoffToken]);

  function validateInputs(): boolean {
    if (!projectName.trim()) {
      Alert.alert("Validation Error", "Project name is required.");
      return false;
    }
    if (!inspectorName.trim()) {
      Alert.alert("Validation Error", "Inspector name is required.");
      return false;
    }
    if (!siteName.trim()) {
      Alert.alert("Validation Error", "Site name is required.");
      return false;
    }
    return true;
  }

  async function submitSurvey() {
    if (!validateInputs()) return;

    if (!deviceId) {
      Alert.alert(
        "Device Error",
        "Device identity is not ready yet. Please try again in a moment.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const now = new Date().toISOString();

      const checklistPhotos = checklist.flatMap((item) =>
        (item.photos ?? []).map((p) => ({
          file_path: p.uri,
          label: p.label?.trim() || `${item.label} Photo`,
          mime_type: p.mimeType,
          captured_at: now,
        })),
      );

      const payload: SurveyFormData = {
        project_name: projectName.trim(),
        project_id: projectId,
        category_id: categoryId,
        category_name: selectedCategoryName,
        inspector_name: inspectorName.trim(),
        site_name: siteName.trim(),
        site_address: siteAddress.trim(),
        latitude: location.coordinates?.latitude ?? null,
        longitude: location.coordinates?.longitude ?? null,
        gps_accuracy: location.coordinates?.accuracy ?? null,
        survey_date: now,
        notes: notes.trim(),
        status: "draft",
        device_id: deviceId,
        metadata: metadata ?? null,
        // F-06 ownership claims forwarded from handoff token
        solarpro_user_id: solarproUserId,
        solarpro_project_id: solarproProjectId,
        solarpro_email: solarproEmail,
        checklist: checklist.map((item, i) => ({
          label: item.label.trim() || `Checklist Item ${i + 1}`,
          status: item.status,
          notes: item.notes ?? "",
          sort_order: i,
        })),
        photos: [
          ...photos.map((p) => ({
            file_path: p.uri,
            label: p.label,
            mime_type: p.mimeType,
            captured_at: now,
          })),
          ...checklistPhotos,
        ],
      };

      const created = await createSurvey(payload, deviceId);

      if (draftFileUri) {
        await FileSystem.deleteAsync(draftFileUri, { idempotent: true });
      }

      Alert.alert("Success", "Survey saved locally and queued for sync.");
      router.push({ pathname: "/survey/[id]", params: { id: created.id } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create survey";
      Alert.alert("Error", message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>New Survey</Text>
          <Text style={styles.autoSaveHint}>Auto-saving draft every 300 seconds</Text>

          <View style={styles.stepBarWrap}>
            {stepLabels.map((label, index) => {
              const step = (index + 1) as 1 | 2 | 3 | 4;
              const active = currentStep === step;
              const done = currentStep > step;
              return (
                <View key={label} style={[styles.stepPill, active && styles.stepPillActive, done && styles.stepPillDone]}>
                  <Text style={[styles.stepPillText, (active || done) && styles.stepPillTextActive]}>
                    {step}. {label}
                  </Text>
                </View>
              );
            })}
          </View>
          <Text style={styles.stepHint}>
            Step {currentStep} of 4 · {stepLabels[currentStep - 1]}
          </Text>

          {currentStep === 1 && (
            <>
              {handoffLinked && projectName.trim() && (
                <View style={styles.linkedBanner}>
                  <Text style={styles.linkedBannerText}>
                    Linked to SolarPro project: {projectName.trim()}
                  </Text>
                </View>
              )}

              <View style={styles.section}>
                <Text style={styles.label}>Project Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter project name"
                  value={projectName}
                  onChangeText={setProjectName}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Inspector Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter inspector name"
                  value={inspectorName}
                  onChangeText={setInspectorName}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Site Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter site name"
                  value={siteName}
                  onChangeText={setSiteName}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Site Address</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter site address"
                  value={siteAddress}
                  onChangeText={setSiteAddress}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>Category</Text>
                <View style={styles.categoryRow}>
                  {SURVEY_CATEGORIES.filter((c) => c.id).map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={[
                        styles.categoryBtn,
                        categoryId === c.id && styles.categoryBtnActive,
                      ]}
                      onPress={() => setCategoryId(c.id)}
                    >
                      <Text
                        style={[
                          styles.categoryBtnText,
                          categoryId === c.id && styles.categoryBtnTextActive,
                        ]}
                      >
                        {c.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <GPSCapture
                coordinates={location.coordinates}
                status={location.status}
                errorMsg={location.errorMsg}
                onCapture={location.capture}
                onClear={location.clear}
              />

              <SolarMetadataForm
                categoryId={categoryId}
                metadata={metadata}
                onChange={setMetadata}
              />
            </>
          )}

          {currentStep === 2 && (
            <ChecklistEditor items={checklist} onChange={setChecklist} />
          )}

          {currentStep === 3 && (
            <>
              <PhotoCapture photos={photos} onChange={setPhotos} />
              {!hasMinimumPhotos && (
                <View style={styles.warningBanner}>
                  <Text style={styles.warningText}>
                    Add at least {requiredPhotoSlots} photos before final submission.
                  </Text>
                </View>
              )}
              <View style={styles.section}>
                <Text style={styles.label}>Notes</Text>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder="Add survey notes"
                  value={notes}
                  onChangeText={setNotes}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  numberOfLines={4}
                />
              </View>
            </>
          )}

          {currentStep === 4 && (
            <View style={styles.section}>
              <Text style={styles.label}>Review & Submit</Text>

              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Project</Text>
                <Text style={styles.reviewVal}>{projectName || '—'}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Inspector</Text>
                <Text style={styles.reviewVal}>{inspectorName || '—'}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Site</Text>
                <Text style={styles.reviewVal}>{siteName || '—'}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Category</Text>
                <Text style={styles.reviewVal}>{selectedCategoryName || '—'}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Checklist Items</Text>
                <Text style={styles.reviewVal}>{checklist.length}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewKey}>Photos</Text>
                <Text style={styles.reviewVal}>{photos.length}</Text>
              </View>

              <TouchableOpacity style={styles.editStepBtn} onPress={() => setCurrentStep(1)}>
                <Text style={styles.editStepText}>Edit Site Info</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.editStepBtn} onPress={() => setCurrentStep(2)}>
                <Text style={styles.editStepText}>Edit Checklist</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.editStepBtn} onPress={() => setCurrentStep(3)}>
                <Text style={styles.editStepText}>Edit Photos</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.navRow}>
            {currentStep > 1 ? (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => setCurrentStep((prev) => (prev - 1) as 1 | 2 | 3 | 4)}
                disabled={submitting}
              >
                <Text style={styles.secondaryBtnText}>← Back</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.back()}>
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}

            {currentStep < 4 ? (
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  ((currentStep === 1 && !canProceedStep1) || submitting) && styles.submitBtnDisabled,
                ]}
                onPress={() => setCurrentStep((prev) => (prev + 1) as 1 | 2 | 3 | 4)}
                disabled={(currentStep === 1 && !canProceedStep1) || submitting}
              >
                <Text style={styles.btnText}>Next →</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                onPress={submitSurvey}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={styles.btnText}>Create Survey</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.textPrimary,
    marginBottom: 8,
  },
  autoSaveHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 10,
  },
  stepBarWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  stepPill: {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBg,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stepPillActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  stepPillDone: {
    borderColor: colors.successBorder,
    backgroundColor: colors.successBg,
  },
  stepPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  stepPillTextActive: {
    color: colors.white,
  },
  stepHint: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '700',
    marginBottom: 14,
  },
  linkedBanner: {
    backgroundColor: colors.successBg,
    borderColor: colors.successBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
  },
  linkedBannerText: {
    color: colors.successText,
    fontSize: 13,
    fontWeight: "700",
  },
  section: {
    marginBottom: 16,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 10,
    padding: 12,
    color: colors.textPrimary,
    fontSize: 16,
  },
  textArea: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  categoryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryBtn: {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBg,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  categoryBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  categoryBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  categoryBtnTextActive: {
    color: colors.white,
  },
  warningBanner: {
    backgroundColor: '#3A2F16',
    borderColor: '#B98A22',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
    marginBottom: 12,
  },
  warningText: {
    color: '#FFD98A',
    fontSize: 13,
    fontWeight: '600',
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 8,
  },
  reviewKey: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  reviewVal: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 10,
  },
  editStepBtn: {
    backgroundColor: colors.inputBg,
    borderColor: colors.inputBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  editStepText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  navRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderColor: colors.inputBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
  },
  submitBtn: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
    marginTop: 0,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 10,
    elevation: 5,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "700",
  },
});
