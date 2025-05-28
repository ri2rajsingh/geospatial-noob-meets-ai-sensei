// Training Data Preparation for Brick Kiln Detection
// This script helps create balanced training datasets for brick kiln detection

// Define study area
var ludhiana = ee.Geometry.Rectangle([75.6, 30.7, 76.0, 31.0]);

// Display study area
Map.centerObject(ludhiana, 10);
Map.addLayer(ludhiana, {color: 'blue'}, 'Study Area - Ludhiana');

// Load Sentinel-2 imagery for visual reference
var s2 = ee.ImageCollection('COPERNICUS/S2_SR')
  .filterDate('2023-01-01', '2023-12-31')
  .filterBounds(ludhiana)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .median()
  .clip(ludhiana);

// Display RGB composite
Map.addLayer(s2, {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'Sentinel-2 RGB');

// Instructions for manual point collection
print('TRAINING DATA COLLECTION GUIDE:');
print('');
print('1. POSITIVE SAMPLES (Brick Kilns):');
print('   - Look for red/orange colored rectangular structures');
print('   - Typically 50-200m in length');
print('   - Located near roads but outside urban areas');
print('   - Often near agricultural fields');
print('   - May have visible smoke/emissions');
print('');
print('2. NEGATIVE SAMPLES (Non-kilns):');
print('   - Industrial buildings (different color/shape)');
print('   - Residential areas');
print('   - Agricultural fields');
print('   - Bare ground/construction sites');
print('   - Water bodies');
print('');
print('3. SAMPLING STRATEGY:');
print('   - Collect 50-60 positive samples');
print('   - Collect 50-60 negative samples');
print('   - Ensure geographic spread across study area');
print('   - Avoid edge cases or ambiguous features');

// Function to validate training points
function validateTrainingData(positivePoints, negativePoints) {
  var posCount = positivePoints.size();
  var negCount = negativePoints.size();
  var totalCount = posCount.add(negCount);
  
  print('TRAINING DATA VALIDATION:');
  print('Positive samples:', posCount);
  print('Negative samples:', negCount);
  print('Total samples:', totalCount);
  print('Class balance ratio:', posCount.divide(negCount));
  
  // Check if points are within study area
  var posInBounds = positivePoints.filterBounds(ludhiana).size();
  var negInBounds = negativePoints.filterBounds(ludhiana).size();
  
  print('Positive points in study area:', posInBounds);
  print('Negative points in study area:', negInBounds);
  
  // Recommendations
  var balanceRatio = posCount.divide(negCount);
  var isBalanced = balanceRatio.gt(0.8).and(balanceRatio.lt(1.25));
  
  print('');
  print('RECOMMENDATIONS:');
  print('Dataset is balanced:', isBalanced);
  print('Minimum recommended: 100 total samples');
  print('Current total:', totalCount);
}

// Load your actual training data collections
var brickKilns = brick_kilns_present; // Replace with your asset path
var nonKilns = brick_kilns_not_present; // Replace with your asset path

validateTrainingData(brickKilns, nonKilns);

// Visualize training points
Map.addLayer(brickKilns, {color: 'red'}, 'Brick Kilns (Positive)');
Map.addLayer(nonKilns, {color: 'blue'}, 'Non-Kilns (Negative)');

// Export training data to Google Drive as shapefiles
Export.table.toDrive({
  collection: brickKilns,
  description: 'positive_samples_brick_kilns',
  folder: 'GEE_Training_Data',
  fileFormat: 'SHP'
});

Export.table.toDrive({
  collection: nonKilns,
  description: 'negative_samples_non_kilns', 
  folder: 'GEE_Training_Data',
  fileFormat: 'SHP'
});

// Also export as GEE Assets for easier reuse
Export.table.toAsset({
  collection: brickKilns,
  description: 'brick_kilns_present_asset',
  assetId: 'users/your_username/brick_kilns_present' // Update with your username
});

Export.table.toAsset({
  collection: nonKilns,
  description: 'brick_kilns_not_present_asset',
  assetId: 'users/your_username/brick_kilns_not_present' // Update with your username
});