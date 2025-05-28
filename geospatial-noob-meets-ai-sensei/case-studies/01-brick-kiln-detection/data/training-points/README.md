# Training Data - Brick Kiln Detection

## Overview
Manually collected training points for brick kiln detection in Ludhiana, Punjab.

## Files
- `positive-samples.*` - Brick kiln locations (60 points)
- `negative-samples.*` - Non-kiln locations (60 points)

### Positive Samples (Brick Kilns)
![Positive Training Examples](training-points/positive%20samples/training_data_positive.png)
*Examples of brick kilns used for positive training samples - note red coloration and rectangular structure*

### Positive Samples (Brick Kilns)
![Negative Training Examples](training-points/negative%20samples/training_data_negative.png)
*Examples of brick kilns used for positive training samples - note red coloration and rectangular structure*



## GEE Asset Paths
```javascript
var brickKilns = ee.FeatureCollection('users/your_username/brick_kilns_present');
var nonKilns = ee.FeatureCollection('users/your_username/brick_kilns_not_present');
```

## Collection Methodology
- **Visual identification** using Sentinel-2 RGB imagery
- **Positive samples**: Red/orange rectangular structures near roads
- **Negative samples**: Similar industrial features, residential areas, fields
- **Geographic spread** across entire Ludhiana district
- **Quality control**: Avoided ambiguous or edge cases

## Validation
- Class balance: ~1:1 ratio
- Total samples: 120 points
- All points within study boundary
- Manually verified accuracy