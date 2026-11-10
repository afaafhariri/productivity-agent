import productivity_agent


def test_version_matches_metadata() -> None:
    assert productivity_agent.__version__ == "0.1.0"
