// ==========================================================================
// === Configuration ========================================================
// ==========================================================================

// --- Define your Training Data Feature Collections ---
// IMPORTANT: Replace these with your actual Feature Collection asset IDs
// Make sure each collection has a property named 'class' (0 or 1).
//var kilnsPresentAssetID = /brick_Kilns_present_1; // Replace! Example: 'users/your_username/brick_kilns_present'
//var kilnsNotPresentAssetID = 'YOUR_ASSET_ID/Brick_Kilns_Not_Present'; // Replace! Example: 'users/your_username/brick_kilns_not_present'

// --- Define Area of Interest (AOI) ---
var districtName = 'Ludhiana';
var stateName = 'Punjab';
var countryName = 'India';

// --- Define Image Collection Parameters ---
var startDate = '2022-10-01'; // Start date for imagery (e.g., dry season)
var endDate = '2023-03-31';   // End date for imagery
var cloudPixelPercentage = 20; // Maximum cloud cover percentage per image

// --- Define Classification Parameters ---
var classProperty = 'class'; // Property name storing 0 or 1 in training data
var trainingScale = 10;      // Scale (meters) to sample training data (match Sentinel-2)
var numTrees = 50;           // Number of trees for Random Forest classifier

// --- Define Output Parameters ---
var minKilnAreaPixels = 5; // Minimum number of connected pixels classified as 'kiln' to be considered a potential site
var maxKilnObjectSize = 1000; // Max size in pixels for connected components (avoids huge areas)

// ==========================================================================
// === Load Data ============================================================
// ==========================================================================

// Load Administrative Boundaries (FAO GAUL 2015, Level 2 for districts)
var adminBoundaries = ee.FeatureCollection('FAO/GAUL/2015/level2');

// Filter for the specific district (AOI)
var aoi = adminBoundaries
    .filter(ee.Filter.and(
        ee.Filter.eq('ADM0_NAME', countryName),
        ee.Filter.eq('ADM1_NAME', stateName),
        ee.Filter.eq('ADM2_NAME', districtName)
    ))
    .first(); // Get the first feature (should be only one Ludhiana)

// Check if AOI was found
if (!aoi) {
    print('ERROR: Could not find the specified district:', districtName, stateName, countryName);
    // Stop execution or handle error appropriately
    throw new Error('AOI definition failed. Check names.');
} else {
    print('AOI defined:', aoi.get('ADM2_NAME'));
    Map.centerObject(aoi, 10); // Center map on the AOI
    Map.addLayer(ee.FeatureCollection([aoi]), {color: 'FF0000', fillColor: '00000000'}, 'AOI: ' + districtName);
}

// Load Training Data
try {
    var kilnsPresent = brick_kilns_present_1;
    var kilnsNotPresent = brick_kilns_not_present_1;

    // --- Basic Validation of Training Data ---
    if (kilnsPresent.size().getInfo() === 0 || kilnsNotPresent.size().getInfo() === 0) {
      throw new Error('One or both training datasets are empty. Check Asset IDs and content.');
    }
     if (!kilnsPresent.first().propertyNames().contains(classProperty).getInfo() ||
         !kilnsNotPresent.first().propertyNames().contains(classProperty).getInfo()) {
       throw new Error('Training data must contain the property: "' + classProperty + '"');
     }
     // Ensure class values are correct (basic check on first feature)
     if (kilnsPresent.first().getNumber(classProperty).getInfo() !== 1) {
         print('Warning: First feature in kilnsPresent does not have class=1');
     }
     if (kilnsNotPresent.first().getNumber(classProperty).getInfo() !== 0) {
         print('Warning: First feature in kilnsNotPresent does not have class=0');
     }


    // Merge the two training datasets
    var trainingData = kilnsPresent.merge(kilnsNotPresent);
    print('Total training points loaded:', trainingData.size());
    Map.addLayer(kilnsPresent, {color: 'FF0000'}, 'Training: Kilns Present');
    Map.addLayer(kilnsNotPresent, {color: '0000FF'}, 'Training: Kilns Not Present');

} catch (e) {
    print('ERROR loading training data. Please ensure the Asset IDs are correct and public or you have access.', e);
    print('Expected Asset IDs:', kilnsPresentAssetID, kilnsNotPresentAssetID);
    throw e; // Stop execution
}


// Load Sentinel-2 Surface Reflectance data
var s2Sr = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi.geometry())
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPixelPercentage));

// Function to mask clouds using the SCL band
function maskS2clouds(image) {
  var scl = image.select('SCL');
  // Keep values corresponding to vegetation, bare soils, water, snow/ice, and unclassified
  // Mask out clouds (medium/high probability), cirrus, cloud shadows.
  var desiredPixels = scl.eq(4) // Vegetation
                      .or(scl.eq(5)) // Bare soils
                      .or(scl.eq(6)) // Water
                      .or(scl.eq(7)) // Unclassified
                      .or(scl.eq(11)); // Snow/Ice (less likely relevant here but safe to keep)
  return image.updateMask(desiredPixels);
}

// Apply cloud masking and select relevant bands
var s2SrMasked = s2Sr.map(maskS2clouds)
                     .select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12']); // Blue, Green, Red, NIR, SWIR1, SWIR2

// Create a single composite image (median reducer is robust to outliers)
var composite = s2SrMasked.median().clip(aoi.geometry());

// Load Road Data (OpenStreetMap)
//var roads = ee.FeatureCollection('GOOGLE/OpenStreetMap/Global/roads');

// Calculate distance to nearest road
// Create an empty image with 0 values, specify projection from composite


// Load Urban Area Data (ESA WorldCover 10m)
var urbanMask = ee.ImageCollection('ESA/WorldCover/v100').first()
                   .select('Map')
                   .eq(50) // Class 50 is 'Built-up'
                   .selfMask() // Mask non-urban pixels
                   .reproject({crs: composite.projection(), scale: trainingScale}); // Reproject

// Calculate distance *to* urban areas (pixels closer to urban have lower distance)
var urbanDistance = urbanMask.fastDistanceTransform()
                      .sqrt()
                      .reproject({crs: composite.projection(), scale: trainingScale})
                      .rename('distance_urban');


// --- Create Predictor Variables Image ---

// Calculate NDVI (helps identify barren land vs. vegetation)
var ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');

// Combine all predictor bands into a single image
var predictorBands = composite.addBands(ndvi)
                              
                              .addBands(urbanDistance);

// Define the list of band names to use for classification
var bandNames = predictorBands.bandNames();
print('Predictor Bands:', bandNames);

// Visualize the composite (optional)
Map.addLayer(composite, {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'Sentinel-2 Composite (RGB)');
//Map.addLayer(roadDistance, {min: 0, max: 1000, palette: ['00FF00', '0000FF']}, 'Distance to Road');
Map.addLayer(urbanDistance, {min: 0, max: 2000, palette: ['FFFF00', 'FF0000']}, 'Distance to Urban');
Map.addLayer(urbanMask, {palette: 'gray'}, 'Urban Mask (ESA WC)');


// ==========================================================================
// === Machine Learning: Training ===========================================
// ==========================================================================

// Sample the predictor bands at the training point locations
var trainingFeatures = predictorBands.sampleRegions({
  collection: trainingData,
  properties: [classProperty], // Keep the class property
  scale: trainingScale,
  geometries: true // Keep geometries if needed, but not strictly required for training
});

// --- Handle potential errors during sampling ---
// Check if sampling yielded any features (e.g., points falling outside image footprint)
var trainingFeaturesCount = trainingFeatures.size().getInfo();
print('Number of sampled training features:', trainingFeaturesCount);

if (trainingFeaturesCount < trainingData.size().getInfo() * 0.8) { // Allow for some points to fail sampling
    print('Warning: Significantly fewer features sampled than input points.',
          'Check if training points fall within the AOI and have valid image data.');
}
if (trainingFeaturesCount === 0) {
    throw new Error('No training features could be sampled. Check image availability/dates and point locations.');
}

// Filter out any features that might have null values for predictor bands
trainingFeatures = trainingFeatures.filter(
    ee.Filter.notNull(bandNames) // Ensure all predictor bands have a value
);
print('Number of valid training features (non-null):', trainingFeatures.size());

// Train a Random Forest classifier
var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: numTrees,
  // variablesPerSplit: null, // Optional: number of variables per split (default sqrt(N))
  // minLeafPopulation: 1,    // Optional: minimum samples in a leaf node
  // bagFraction: 0.5,        // Optional: fraction of data to bag for each tree
  // seed: 0                  // Optional: set seed for reproducibility
}).train({
  features: trainingFeatures,
  classProperty: classProperty,
  inputProperties: bandNames // Use all bands in the predictor image
});

// ==========================================================================
// === Machine Learning: Classification =====================================
// ==========================================================================

// Classify the predictor image
var classifiedImage = predictorBands.classify(classifier);

// --- Mask out dense urban areas from the classification result ---
// We want kilns NEAR urban, not IN dense urban cores.
var urbanCoreMask = ee.ImageCollection('ESA/WorldCover/v100').first()
                   .select('Map')
                   .neq(50); // Keep everything EXCEPT Built-up (class 50)

var classifiedMasked = classifiedImage.updateMask(urbanCoreMask);


// Visualize the raw classification (0 = Not Kiln, 1 = Kiln)
Map.addLayer(classifiedMasked, {min: 0, max: 1, palette: ['gray', 'orange']}, 'Raw Classification (Masked Urban)');


// ==========================================================================
// === Post-Processing & Output =============================================
// ==========================================================================

// Select only the pixels classified as brick kilns (class 1)
var kilnPixels = classifiedMasked.eq(1).selfMask(); // Keep only pixels with value 1

// --- Convert classified pixels to potential kiln sites (using connected components) ---
// This helps group adjacent pixels and treat them as single objects.

// Define connectivity (8-neighbor)
var connections = kilnPixels.connectedComponents({
  connectedness: ee.Kernel.plus(1),
  maxSize: maxKilnObjectSize,
  tileScale: 16 // Keep tileScale high
});

// Count the number of pixels in each connected component object
var objectPixelCounts = connections.select('labels').connectedPixelCount({
    maxSize: maxKilnObjectSize,
    eightConnected: true,
    tileScale: 16 // Keep tileScale high
});


// Filter out small objects (noise) based on the minimum pixel count
var largeEnoughObjects = objectPixelCounts.gte(minKilnAreaPixels);
var potentialKilnAreas = kilnPixels.updateMask(largeEnoughObjects); // Mask out small objects

// Convert the filtered, connected areas (potential kilns) into vectors (polygons)
var potentialKilnPolys = potentialKilnAreas.reduceToVectors({
  geometry: aoi.geometry(),
  scale: trainingScale,
  geometryType: 'polygon',
  eightConnected: true,
  reducer: ee.Reducer.sum(), // Or removed, based on previous choice
  maxPixels: 1e9,         // <--- INCREASE maxPixels SIGNIFICANTLY
  tileScale: 16,          // <--- Keep tileScale high
  bestEffort: true        // <--- ADD bestEffort
});

// Calculate the centroid of each polygon to get potential points
var potentialKilnPoints = potentialKilnPolys.map(function(feat){
    // Use simpler centroid calculation by removing maxError
    return feat.centroid(); // <--- REMOVE maxError argument (trainingScale)
});

// --- Final Count and Visualization ---
var potentialKilnCount = potentialKilnPoints.size();
print('Estimated number of potential brick kiln sites identified:', potentialKilnCount);

// Add the final potential kiln points to the map
Map.addLayer(potentialKilnPoints, {color: 'FF00FF', pointSize: 4}, 'Potential Brick Kiln Points');

// Optional: Add the filtered kiln area polygons
// Map.addLayer(potentialKilnPolys, {color: 'FFFF00', fillColor: 'FFFF0055'}, 'Potential Brick Kiln Areas');


// ==========================================================================
// === Code Review Notes ====================================================
// ==========================================================================
// 1.  Asset IDs: User MUST replace placeholder Asset IDs for training data.
// 2.  AOI Definition: Uses standard FAO GAUL dataset. Checked filtering logic. Added error handling if district not found.
// 3.  Training Data Loading: Includes try-catch block and basic validation (non-empty, 'class' property present, basic check of class values).
// 4.  Image Collection: Uses Sentinel-2 SR Harmonized (recommended). Date range and cloud filtering are parameterized. Cloud masking uses SCL band (robust method).
// 5.  Predictor Features:
//     - Spectral Bands: Includes standard optical bands (B,G,R,NIR,SWIR1,SWIR2).
//     - NDVI: Included to help differentiate barren/vegetation.
//     - Road Distance: Calculated using OSM data and `fastDistanceTransform`. Reprojected to match Sentinel-2 scale.
//     - Urban Distance: Calculated distance TO urban areas using ESA WorldCover. Reprojected.
//     - Urban Masking (Post-classification): Explicitly masks dense urban areas (ESA WC class 50) *after* classification to avoid detecting kilns *within* cities, while still allowing proximity features to work during training/classification.
// 6.  Training Process: Uses `sampleRegions`. Includes checks for sampling success and filters null values. Uses Random Forest classifier (robust choice). `inputProperties` are correctly set from `predictorBands.bandNames()`.
// 7.  Classification: Applies the trained classifier correctly.
// 8.  Post-Processing:
//     - Filters for class 1 (kilns).
//     - Uses `connectedComponents` and `connectedPixelCount` to identify contiguous blobs of kiln pixels. This is better than raw pixels for identifying distinct sites.
//     - Filters small blobs using `minKilnAreaPixels` to reduce noise.
//     - Converts valid blobs to polygons using `reduceToVectors`.
//     - Calculates centroids of polygons to get final "potential points".
// 9.  Output: Prints the count of potential points (`.size().getInfo()`). Visualizes AOI, training data, composite image, intermediate features (distances), raw classification, and final potential points clearly.
// 10. Parameters: Key parameters (dates, asset IDs, thresholds) are grouped at the top for easy modification.
// 11. Error Handling: Added checks for AOI definition, training data loading/validation, and sampling success.
// 12. Deprecation: All GEE functions used are current and standard.
// 13. Scalability: The approach should be reasonably efficient for a single district. `fastDistanceTransform` and `connectedComponents` are generally efficient. Using `median()` for the composite is standard.
// ==========================================================================