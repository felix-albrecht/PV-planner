# PV production predictor

There are some very nice calculation tools for yearly/monthly/daily PV production, e.g.:
- https://globalsolaratlas.info
- https://re.jrc.ec.europa.eu/pvg_tools

However, none of them are able to create multiple sections with different azimuth, tilt etc. like it is the case for a complex house setup.

This simple web app lets you create these different sections, then fetch data from the PVGIS v5.3 API and display them nicely.

# Installation

Launch a local python webserver:
```python
pip install -r requirements.txt
python app.py
```

Then open the web app:
```
http://localhost:5001
```

# Usage

An example config is stored in `configs/pv_config_example_Berlin.json`.

Search for your location and enter details about the PV system, like peak power, azimuth and tilt.

![Data input](screenshots/input.png)

Then get the solar irradiation data and calculate monthly production, and daily profiles.

![PV production histogram](screenshots/histogram.png)

![PV production profile](screenshots/profile.png)

Download the calculated data for further analysis as csv, and the PV config as json.
