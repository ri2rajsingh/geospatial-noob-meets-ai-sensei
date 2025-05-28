// Define Ludhiana as the study area (approximate bounding box)
var ludhiana = ee.Geometry.Rectangle([75.6, 30.7, 76.0, 31.0]);

// Sample brick kiln points (40 points, class = 1) from an existing collection
// Replace 'kilnCollection' with your actual FeatureCollection, e.g.:
// var kilnCollection = ee.FeatureCollection('users/your_username/kiln_points');
// Ensure the collection has at least 40 points within Ludhiana
var kilnCollection = brick_kilns_present_1; // Placeholder
var brick_kilns_present = kilnCollection
  .filterBounds(ludhiana)
  .randomColumn('random', 42)
  .limit(60, 'random')
  .map(function(f) { return f.set('class', 1); });

// Debug: Verify positive points count
print('Positive Points Count:', brick_kilns_present.size());

// Import ESA WorldCover (kept for potential visualization, not used for sampling)
var landCover = ee.ImageCollection('ESA/WorldCover/v100').first().clip(ludhiana);
var urbanAreas = landCover.eq(50).rename('urban');
var nonFarmland = landCover.neq(10);

// Sample non-kiln points (40 points, class = 0) from an existing collection
// Replace 'nonKilnCollection' with your actual FeatureCollection, e.g.:
// var nonKilnCollection = ee.FeatureCollection('users/your_username/non_kiln_points');
// Ensure the collection has at least 40 points within Ludhiana
var nonKilnCollection = brick_kilns_not_present_1; // Placeholder
var brick_kilns_not_present = nonKilnCollection
  .filterBounds(ludhiana)
  .randomColumn('random', 42)
  .limit(60, 'random')
  .map(function(f) { return f.set('class', 0); });

// Debug: Verify negative points count
print('Negative Points Count:', brick_kilns_not_present.size());

// Import Sentinel-2 Surface Reflectance data and select bands
var bands = ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'];
var s2 = ee.ImageCollection('COPERNICUS/S2_SR')
  .filterDate('2023-01-01', '2023-12-31')
  .filterBounds(ludhiana)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .select(bands);

// Create a median composite
var s2Median = s2.median().clip(ludhiana);

// Calculate NDVI, NDBI, BSI, and MSAVI
var ndvi = s2Median.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndbi = s2Median.normalizedDifference(['B11', 'B8']).rename('NDBI');
var bsi = s2Median.expression(
  '((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))',
  {
    'SWIR1': s2Median.select('B11'),
    'RED': s2Median.select('B4'),
    'NIR': s2Median.select('B8'),
    'BLUE': s2Median.select('B2')
  }).rename('BSI');
var msavi = s2Median.expression(
  '(2 * NIR + 1 - sqrt(pow(2 * NIR + 1, 2) - 8 * (NIR - RED))) / 2',
  {
    'NIR': s2Median.select('B8'),
    'RED': s2Median.select('B4')
  }).rename('MSAVI');

// Custom Red-Enhancing Index
var redIndex = s2Median.expression(
  'RED / (GREEN + BLUE)',
  {
    'RED': s2Median.select('B4'),
    'GREEN': s2Median.select('B3'),
    'BLUE': s2Median.select('B2')
  }).rename('RedIndex');

// Add GLCM texture features
var b4Int = s2Median.select('B4').toInt32();
var texture = b4Int.glcmTexture({size: 1});
var textureBands = ['B4_contrast', 'B4_corr', 'B4_var'];
var textureFeatures = texture.select(textureBands);

// Combine bands, indices, and texture
var featureStack = s2Median
  .addBands([ndvi, ndbi, bsi, msavi, redIndex])
  .addBands(textureFeatures);

// Combine positive and negative points
var trainingPoints = brick_kilns_present.merge(brick_kilns_not_present);

// Validate training points
trainingPoints = trainingPoints.filterBounds(ludhiana);
print('Training Points Count:', trainingPoints.size());

// Extract pixel values at training points
var training = featureStack.sampleRegions({
  collection: trainingPoints,
  properties: ['class'],
  scale: 10,
  tileScale: 8
});

// Split data into training (70%) and testing (30%)
var trainingData = training.randomColumn('random', 42);
var trainSet = trainingData.filter(ee.Filter.lt('random', 0.7));
var testSet = trainingData.filter(ee.Filter.gte('random', 0.7));

// Train a Random Forest classifier with probability output
var classifier = ee.Classifier.smileRandomForest(50)
  .setOutputMode('PROBABILITY')
  .train({
    features: trainSet,
    classProperty: 'class',
    inputProperties: featureStack.bandNames()
  });

// Classify the image with probability
var probImage = featureStack.classify(classifier).rename('probability');

// Apply threshold to create binary classification
var classified = probImage.gt(0.7).rename('classification');

// Post-process to enforce minimum kiln size (0.5 ha = 50 pixels at 10m)
var minPixels = 50;
var connected = classified.connectedPixelCount(100, false);
var classified = classified.updateMask(connected.gte(minPixels))
  .reproject({crs: 'EPSG:4326', scale: 10});

// Create a coarser version for visualization
var classifiedForDisplay = classified.reproject({crs: 'EPSG:4326', scale: 30});

// CHANGE: Extract likely kiln locations as a FeatureCollection
// Identify kiln patches at 30m to avoid memory limits
var kilnPatches = classified.eq(1).reproject({crs: 'EPSG:4326', scale: 30}).connectedComponents({
  connectedness: ee.Kernel.plus(1),
  maxSize: 256
});

// Convert patches to geometries (polygons)
var kilnPolygons = kilnPatches.select('labels').reduceToVectors({
  reducer: ee.Reducer.countEvery(),
  geometry: ludhiana,
  scale: 30,
  maxPixels: 50000000,
  geometryType: 'polygon'
});

// Convert polygons to centroids with properties
var kilnCentroids = kilnPolygons.map(function(feature) {
  var centroid = feature.centroid({maxError: 1});
  var pixelCount = ee.Number(feature.get('count')); // Pixels in patch (30m)
  var areaHa = pixelCount.multiply(900).divide(10000); // Area in ha (30m pixels = 900m²)
  var meanProb = probImage.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: feature.geometry(),
    scale: 10,
    maxPixels: 50000000
  }).get('probability');
  return centroid.set({
    'patch_id': feature.get('label'),
    'pixel_count_30m': pixelCount,
    'area_ha': areaHa,
    'mean_probability': meanProb
  });
});

// Debug: Print number of kilns and sample locations
print('Number of Identified Kilns:', kilnCentroids.size());
print('Sample Kiln Centroids (First 5):', kilnCentroids.limit(5));

// CHANGE: Export kiln centroids to GEE Asset
Export.table.toAsset({
  collection: kilnCentroids,
  description: 'Ludhiana_Kiln_Centroids',
  assetId: 'users/your_username/Ludhiana_Kiln_Centroids' // Replace with your GEE asset path
});

// CHANGE: Export kiln centroids to Google Drive as shapefile
Export.table.toDrive({
  collection: kilnCentroids,
  description: 'Ludhiana_Kiln_Centroids',
  folder: 'GEE_Exports',
  fileFormat: 'SHP'
});

// Validate kiln count and area
var kilnCount = kilnPatches.select('labels').reduceRegion({
  reducer: ee.Reducer.countDistinctNonNull(),
  geometry: ludhiana,
  scale: 30,
  maxPixels: 50000000
}).get('labels');
var pixelCount = classified.eq(1).reduceRegion({
  reducer: ee.Reducer.count(),
  geometry: ludhiana,
  scale: 30,
  maxPixels: 50000000
}).get('classification');
print('Kiln Pixel Count (30m):', pixelCount);
print('Estimated Number of Kilns:', kilnCount);

// Compute total kiln area at 10m scale
var kilnAreaHa = classified.eq(1).multiply(ee.Image.pixelArea()).divide(10000).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: ludhiana,
  scale: 10,
  maxPixels: 50000000
}).get('classification');
print('Total Kiln Area (ha):', kilnAreaHa);

// Evaluate the model on the test set
var confusionMatrix = testSet.classify(classifier)
  .errorMatrix('class', 'classification');
print('Confusion Matrix:', confusionMatrix);
print('Overall Accuracy:', confusionMatrix.accuracy());

// Add precision, recall, and F1-score
print('Precision (Consumers Accuracy):', confusionMatrix.consumersAccuracy());
print('Recall (Producers Accuracy):', confusionMatrix.producersAccuracy());
var precision = confusionMatrix.consumersAccuracy();
var recall = confusionMatrix.producersAccuracy();
var f1Score = precision.add(recall).multiply(2).divide(precision.add(recall));
print('F1-Score:', f1Score);

// Detailed feature importance
var importance = classifier.explain().get('importance');
print('Feature Importance Details:', importance);

// Perform stratified k-fold cross-validation
var folds = 5;
var positivePoints = training.filter(ee.Filter.eq('class', 1));
var negativePoints = training.filter(ee.Filter.eq('class', 0));
var positiveFolds = positivePoints.randomColumn('fold', 42);
var negativeFolds = negativePoints.randomColumn('fold', 42);
var foldResults = ee.List.sequence(0, folds-1).map(function(fold) {
  var foldNum = ee.Number(fold);
  var trainPos = positiveFolds.filter(ee.Filter.or(
    ee.Filter.lt('fold', foldNum.divide(folds)),
    ee.Filter.gte('fold', (foldNum.add(1)).divide(folds))
  ));
  var testPos = positiveFolds.filter(ee.Filter.and(
    ee.Filter.gte('fold', foldNum.divide(folds)),
    ee.Filter.lt('fold', (foldNum.add(1)).divide(folds))
  ));
  var trainNeg = negativeFolds.filter(ee.Filter.or(
    ee.Filter.lt('fold', foldNum.divide(folds)),
    ee.Filter.gte('fold', (foldNum.add(1)).divide(folds))
  ));
  var testNeg = negativeFolds.filter(ee.Filter.and(
    ee.Filter.gte('fold', foldNum.divide(folds)),
    ee.Filter.lt('fold', (foldNum.add(1)).divide(folds))
  ));
  var trainFold = trainPos.merge(trainNeg);
  var testFold = testPos.merge(testNeg);
  var debugInfo = ee.Dictionary({
    fold: foldNum,
    trainSize: trainFold.size(),
    testSize: testFold.size(),
    testClasses: testFold.aggregate_histogram('class')
  });
  var foldClassifier = ee.Classifier.smileRandomForest(50)
    .train({
      features: trainFold,
      classProperty: 'class',
      inputProperties: featureStack.bandNames()
    });
  var confusionMatrix = testFold.classify(foldClassifier)
    .errorMatrix('class', 'classification');
  return ee.List([confusionMatrix.accuracy(), debugInfo]);
});
var accuracies = foldResults.map(function(result) { return ee.List(result).get(0); });
var debugInfos = foldResults.map(function(result) { return ee.List(result).get(1); });
print('Fold Debug Info:', debugInfos);
print('Cross-Validation Accuracies:', accuracies);

// Visualize results
Map.centerObject(ludhiana, 9);
Map.addLayer(s2Median, {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'Sentinel-2 RGB');
Map.addLayer(classifiedForDisplay, {min: 0, max: 1, palette: ['gray', 'red']}, 'Brick Kiln Classification');
Map.addLayer(brick_kilns_present, {color: 'yellow'}, 'Kiln Points (Present)');
Map.addLayer(brick_kilns_not_present, {color: 'blue'}, 'Non-Kiln Points (Not Present)');
Map.addLayer(redIndex, {min: 0, max: 2, palette: ['blue', 'white', 'red']}, 'Red-Enhancing Index');
Map.addLayer(probImage, {min: 0, max: 1, palette: ['blue', 'white', 'red']}, 'Kiln Probability');

// CHANGE: Visualize kiln centroids
Map.addLayer(kilnCentroids, {color: 'orange'}, 'Kiln Centroids');